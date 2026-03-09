from flask import (Flask, render_template, request, redirect,
                   url_for, session, jsonify, Response, stream_with_context)
import instaloader
from datetime import datetime
import requests
import os, json, time, queue, threading, hashlib, secrets
import feedparser
import praw
import psycopg2
import psycopg2.extras
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = os.environ.get('DATABASE_URL', '')  # set in Railway variables

# ─── PLAID ───────────────────────────────────────────────────────
from plaid.model.link_token_create_request          import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user     import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.accounts_get_request               import AccountsGetRequest
from plaid.model.products     import Products
from plaid.model.country_code import CountryCode
from plaid.api                import plaid_api
from plaid.configuration      import Configuration
from plaid.api_client         import ApiClient
import plaid

# ─── GOOGLE ──────────────────────────────────────────────────────
from google.oauth2.credentials         import Credentials
from google_auth_oauthlib.flow         import InstalledAppFlow
from googleapiclient.discovery         import build

# ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = 'CHANGE-THIS-TO-SOMETHING-LONG-AND-RANDOM-IN-PRODUCTION'

# ─── CONFIG ──────────────────────────────────────────────────────
YOUTUBE_API_KEY     = 'AIzaSyDtQ0t9LZXxEGigG96McFwnjOzBhPH7cA0'
GOOGLE_MAPS_API_KEY = 'AIzaSyABcseoVUTnaJ2TUzxtU-hd8bDRbhZCKEU'
GOOGLE_CREDS_FILE   = os.path.join(BASE_DIR, 'credentials.json')
REDDIT_CLIENT_ID    = 'your_client_id_here'
REDDIT_CLIENT_SECRET= 'your_client_secret_here'
REDDIT_USER_AGENT   = 'MyDashboard/1.0'
SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/youtube.readonly',
]
PLAID_CLIENT_ID = '698bcf320c11b40020cc3d6d'
PLAID_SECRET    = 'c0e1ff61bffa474610430fae26a755'

configuration = Configuration(
    host=plaid.Environment.Sandbox,
    api_key={'clientId': PLAID_CLIENT_ID, 'secret': PLAID_SECRET}
)
api_client   = ApiClient(configuration)
plaid_client = plaid_api.PlaidApi(api_client)

DEFAULT_CHANNELS = [
    'UCX6OQ3DkcsbYNE6H8uQQuVA',
    'UCBcRF18a7Qf58cCRy5xuWwQ',
    'UC-lHJZR3Gqxm24_Vd_AJ5Yw',
    'UCnUYZLuoy1rq1aVMwx4aTzw',
    'UCWX3yGbODI3CLqBPwKDTAJA',
]

# ═══════════════════════════════════════════════════════════════════
#  DATABASE  (PostgreSQL via Supabase)
# ═══════════════════════════════════════════════════════════════════
def get_db():
    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    return conn

def init_db():
    try:
        with get_db() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS users (
                        id            SERIAL PRIMARY KEY,
                        username      TEXT   UNIQUE NOT NULL,
                        email         TEXT   UNIQUE NOT NULL,
                        display_name  TEXT   NOT NULL DEFAULT '',
                        avatar_color  TEXT   NOT NULL DEFAULT '#ff8c42',
                        password_hash TEXT   NOT NULL,
                        salt          TEXT   NOT NULL,
                        created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
                        last_seen     TIMESTAMP
                    );
                    CREATE TABLE IF NOT EXISTS messages (
                        id            SERIAL PRIMARY KEY,
                        sender_id     INTEGER NOT NULL REFERENCES users(id),
                        recipient_id  INTEGER,
                        room          TEXT    NOT NULL DEFAULT 'global',
                        body          TEXT    NOT NULL,
                        sent_at       TIMESTAMP NOT NULL DEFAULT NOW(),
                        read          BOOLEAN NOT NULL DEFAULT FALSE
                    );
                """)
            conn.commit()
        print("[DB] PostgreSQL initialized OK")
    except Exception as e:
        print(f"[DB] init_db failed: {e}")

init_db()

# ═══════════════════════════════════════════════════════════════════
#  AUTH HELPERS
# ═══════════════════════════════════════════════════════════════════
def hash_password(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 100_000).hex()

def make_salt():
    return secrets.token_hex(32)

def create_user(username, email, display_name, password):
    salt   = make_salt()
    pwhash = hash_password(password, salt)
    colors = ['#ff8c42','#4488ff','#22dd88','#ff4466','#aa44ff','#ffcc00','#00ccaa','#ff6688']
    color  = secrets.choice(colors)
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO users (username,email,display_name,avatar_color,password_hash,salt) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                (username.lower(), email.lower(), display_name or username, color, pwhash, salt)
            )
        conn.commit()

def verify_user(ident, password):
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT * FROM users WHERE username=%s OR email=%s",
                (ident.lower(), ident.lower())
            )
            row = cur.fetchone()
    if not row:
        return None
    if secrets.compare_digest(hash_password(password, row['salt']), row['password_hash']):
        return dict(row)
    return None

def get_user_by_id(uid):
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("SELECT * FROM users WHERE id=%s", (uid,))
            row = cur.fetchone()
    return dict(row) if row else None

def get_all_users_except(uid):
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id,username,display_name,avatar_color,last_seen "
                "FROM users WHERE id!=%s ORDER BY display_name",
                (uid,)
            )
            rows = cur.fetchall()
    return [dict(r) for r in rows]

def update_last_seen(uid):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE users SET last_seen=NOW() WHERE id=%s", (uid,))
        conn.commit()

def unread_count(uid):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM messages WHERE recipient_id=%s AND read=FALSE", (uid,)
            )
            row = cur.fetchone()
    return row[0] if row else 0

def mark_dm_read(room, uid):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE messages SET read=TRUE WHERE room=%s AND recipient_id=%s", (room, uid)
            )
        conn.commit()

def login_required(f):
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return wrapper

# ═══════════════════════════════════════════════════════════════════
#  SERVER-SENT EVENTS
# ═══════════════════════════════════════════════════════════════════
_sse_clients = {}
_sse_lock    = threading.Lock()

def sse_subscribe(uid):
    q = queue.Queue(maxsize=100)
    with _sse_lock:
        _sse_clients.setdefault(uid, []).append(q)
    return q

def sse_unsubscribe(uid, q):
    with _sse_lock:
        lst = _sse_clients.get(uid, [])
        if q in lst:
            lst.remove(q)

def sse_push(uid, data):
    payload = 'data: ' + json.dumps(data) + '\n\n'
    with _sse_lock:
        for q in list(_sse_clients.get(uid, [])):
            try: q.put_nowait(payload)
            except queue.Full: pass

def sse_broadcast(data, exclude_id=None):
    payload = 'data: ' + json.dumps(data) + '\n\n'
    with _sse_lock:
        for uid, queues in _sse_clients.items():
            if uid == exclude_id: continue
            for q in list(queues):
                try: q.put_nowait(payload)
                except queue.Full: pass

# ═══════════════════════════════════════════════════════════════════
#  MESSAGING HELPERS
# ═══════════════════════════════════════════════════════════════════
def save_message(sender_id, body, room='global', recipient_id=None):
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages (sender_id,recipient_id,room,body) VALUES (%s,%s,%s,%s) RETURNING id",
                (sender_id, recipient_id, room, body)
            )
            msg_id = cur.fetchone()[0]
        conn.commit()
    return msg_id

def get_room_messages(room='global', limit=80):
    with get_db() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("""
                SELECT m.id, m.body,
                       TO_CHAR(m.sent_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS sent_at,
                       m.room, u.username, u.display_name, u.avatar_color
                FROM messages m
                JOIN users u ON u.id = m.sender_id
                WHERE m.room=%s
                ORDER BY m.sent_at DESC LIMIT %s
            """, (room, limit))
            rows = cur.fetchall()
    return [dict(r) for r in reversed(rows)]

def get_dm_room(a, b):
    return 'dm_{}_{}'.format(*sorted([a, b]))

# ═══════════════════════════════════════════════════════════════════
#  DATA HELPERS  (unchanged from before)
# ═══════════════════════════════════════════════════════════════════
def get_reddit_client():
    try:
        return praw.Reddit(
            client_id=REDDIT_CLIENT_ID, client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDIT_USER_AGENT,
            username=session.get('reddit_username'),
            password=session.get('reddit_password')
        )
    except Exception as e:
        print(f"Reddit client error: {e}"); return None

def get_reddit_stats():
    reddit = get_reddit_client()
    if not reddit or not session.get('reddit_username'):
        return {'error': 'Not connected'}
    try:
        u = reddit.user.me()
        return {'username': u.name, 'link_karma': u.link_karma,
                'comment_karma': u.comment_karma,
                'total_karma': u.link_karma + u.comment_karma,
                'created': datetime.fromtimestamp(u.created_utc).strftime('%Y-%m-%d')}
    except Exception as e:
        return {'error': str(e)}

def get_reddit_posts(subreddits=['all'], limit=10):
    reddit = get_reddit_client()
    if not reddit: return []
    posts = []
    try:
        for sub in subreddits:
            for s in reddit.subreddit(sub).hot(limit=limit):
                if s.stickied: continue
                thumb = s.thumbnail if s.thumbnail.startswith('http') else None
                posts.append({
                    'platform':'reddit','title':s.title,
                    'subreddit':s.subreddit.display_name,
                    'author':s.author.name if s.author else '[deleted]',
                    'score':s.score,'num_comments':s.num_comments,
                    'url':f"https://reddit.com{s.permalink}",
                    'thumbnail':thumb,'is_video':s.is_video,
                    'published':datetime.fromtimestamp(s.created_utc).isoformat(),
                    'time_ago':get_time_ago(datetime.fromtimestamp(s.created_utc).isoformat())
                })
                if len(posts) >= limit: break
            if len(posts) >= limit: break
        return posts
    except Exception as e:
        print(f"Reddit posts error: {e}"); return []

def get_gmail_unread(creds):
    try:
        svc = build('gmail','v1',credentials=creds)
        res = svc.users().messages().list(userId='me',labelIds=['INBOX','UNREAD'],maxResults=5).execute()
        msgs = res.get('messages',[])
        out  = []
        for m in msgs:
            md = svc.users().messages().get(userId='me',id=m['id'],format='metadata',
                                            metadataHeaders=['From','Subject']).execute()
            h = {x['name']:x['value'] for x in md['payload']['headers']}
            out.append({'from':h.get('From','Unknown'),'subject':h.get('Subject','(No subject)')})
        return {'count':len(msgs),'messages':out}
    except Exception as e:
        return {'error':str(e)}

def get_calendar_events(creds):
    try:
        svc = build('calendar','v3',credentials=creds)
        now = datetime.utcnow().isoformat()+'Z'
        res = svc.events().list(calendarId='primary',timeMin=now,
                                maxResults=5,singleEvents=True,orderBy='startTime').execute()
        events = []
        for ev in res.get('items',[]):
            start = ev['start'].get('dateTime',ev['start'].get('date'))
            events.append({'summary':ev.get('summary','No title'),
                           'start':start,'location':ev.get('location',''),'id':ev['id']})
        return {'events':events}
    except Exception as e:
        return {'error':str(e)}

def get_youtube_subscriptions(creds):
    try:
        svc = build('youtube','v3',credentials=creds)
        subs = svc.subscriptions().list(part='snippet',mine=True,maxResults=10).execute()
        return [i['snippet']['resourceId']['channelId'] for i in subs.get('items',[])]
    except Exception as e:
        print(f"Subscription error: {e}"); return []

def get_instagram_followers(username):
    # Instaloader is blocked by Instagram on cloud servers (rate limited immediately)
    # Return a graceful placeholder instead of hanging the worker
    return {'error': 'Instagram connection not available on server'}

def get_instagram_posts(username):
    # Same — instaloader times out on cloud hosts, skip entirely
    return []
    try:
        data = requests.get(f"https://wttr.in/{city}?format=j1", timeout=8).json()
        cur  = data['current_condition'][0]
        forecast = []
        for day in data.get('weather',[]):
            ds = day['date']
            try:   dn = datetime.strptime(ds,'%Y-%m-%d').strftime('%a')
            except: dn = ds
            forecast.append({'day':dn,'date':ds,
                'high':day['maxtempF']+'°','low':day['mintempF']+'°',
                'condition':day['hourly'][4]['weatherDesc'][0]['value'],
                'rain_chance':day['hourly'][4].get('chanceofrain','0')+'%'})
        return {'city':city,'temp':cur['temp_F']+'°F',
                'condition':cur['weatherDesc'][0]['value'],
                'feels_like':cur['FeelsLikeF']+'°F',
                'humidity':cur['humidity']+'%','forecast':forecast}
    except Exception as e:
        return {'error':str(e)}

def get_date_time():
    n = datetime.now()
    return {'date':n.strftime('%A, %B %d, %Y'),'time':n.strftime('%I:%M %p')}

def get_news():
    try:
        feed = feedparser.parse("https://feeds.reuters.com/reuters/topNews")
        return [{'title':e.title,'summary':getattr(e,'summary',''),'link':e.link}
                for e in feed.entries[:6]]
    except: return []

def get_time_ago(ts):
    try:
        pt = datetime.fromisoformat(ts.replace('Z','+00:00'))
        s  = (datetime.now(pt.tzinfo)-pt).total_seconds()
        if s < 3600:  return f"{int(s/60)}m ago"
        if s < 86400: return f"{int(s/3600)}h ago"
        return f"{int(s/86400)}d ago"
    except: return "recently"

def get_youtube_videos(channel_ids):
    videos = []
    if isinstance(channel_ids, str): channel_ids = [channel_ids]
    for cid in channel_ids[:10]:
        try:
            data = requests.get(
                f"https://www.googleapis.com/youtube/v3/search?key={YOUTUBE_API_KEY}"
                f"&channelId={cid}&part=snippet,id&order=date&maxResults=3", timeout=5
            ).json()
            for item in data.get('items',[]):
                if item['id']['kind']=='youtube#video':
                    videos.append({
                        'platform':'youtube','title':item['snippet']['title'],
                        'channel':item['snippet']['channelTitle'],
                        'thumbnail':item['snippet']['thumbnails']['high']['url'],
                        'video_id':item['id']['videoId'],
                        'published':item['snippet']['publishedAt'],
                        'time_ago':get_time_ago(item['snippet']['publishedAt'])
                    })
        except Exception as e:
            print(f"YouTube error {cid}: {e}")
    return videos

def get_unified_feed(channel_ids, username, subreddits=['popular','news','technology']):
    posts = (get_youtube_videos(channel_ids)+get_instagram_posts(username)
             +get_reddit_posts(subreddits))
    posts.sort(key=lambda x: x['published'], reverse=True)
    return posts[:30]

def get_bank_accounts():
    token = session.get('plaid_access_token')
    if not token: return None
    try:
        resp = plaid_client.accounts_get(AccountsGetRequest(access_token=token))
        return [{'name':a['name'],'type':a['type'],'subtype':a['subtype'],
                 'balance':a['balances']['current']} for a in resp['accounts']]
    except: return None

# ═══════════════════════════════════════════════════════════════════
#  SPORTS
# ═══════════════════════════════════════════════════════════════════
SPORTS_LEAGUES = [
    {'key':'nba',   'label':'NBA',   'icon':'🏀','url':'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'},
    {'key':'nfl',   'label':'NFL',   'icon':'🏈','url':'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'},
    {'key':'mlb',   'label':'MLB',   'icon':'⚾','url':'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'},
    {'key':'nhl',   'label':'NHL',   'icon':'🏒','url':'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'},
    {'key':'epl',   'label':'EPL',   'icon':'⚽','url':'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard'},
    {'key':'ncaafb','label':'NCAAF', 'icon':'🏈','url':'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard'},
    {'key':'ncaamb','label':'NCAAB', 'icon':'🏀','url':'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard'},
    {'key':'ufc',   'label':'UFC',   'icon':'🥊','url':'https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard'},
]

def parse_espn_scoreboard(data, label, icon):
    events = []
    for event in data.get('events',[]):
        try:
            comp   = event['competitions'][0]
            status = event['status']
            state  = status['type']['state']
            detail = status['type']['shortDetail']
            comps  = comp.get('competitors',[])
            home   = next((c for c in comps if c.get('homeAway')=='home'), comps[0] if comps else {})
            away   = next((c for c in comps if c.get('homeAway')=='away'), comps[-1] if comps else {})
            events.append({
                'league':label,'icon':icon,'state':state,'detail':detail,
                'home':home.get('team',{}).get('abbreviation','?'),
                'away':away.get('team',{}).get('abbreviation','?'),
                'home_score':home.get('score',''),'away_score':away.get('score',''),
            })
        except: continue
    return events

@app.route('/api/scores')
def api_scores():
    all_events = []
    for lg in SPORTS_LEAGUES:
        try:
            d = requests.get(lg['url'], timeout=4).json()
            all_events.extend(parse_espn_scoreboard(d, lg['label'], lg['icon']))
        except Exception as e:
            print(f"Scores error {lg['key']}: {e}")
    order = {'in':0,'pre':1,'post':2}
    all_events.sort(key=lambda e: order.get(e['state'],9))
    return jsonify(all_events)

# ═══════════════════════════════════════════════════════════════════
#  AUTH ROUTES
# ═══════════════════════════════════════════════════════════════════
@app.route('/login', methods=['GET','POST'])
def login():
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    error = None
    if request.method == 'POST':
        ident = request.form.get('identifier','').strip()
        pw    = request.form.get('password','')
        user  = verify_user(ident, pw)
        if user:
            session.permanent = True
            session['user_id']      = user['id']
            session['username']     = user['username']
            session['display_name'] = user['display_name']
            session['avatar_color'] = user['avatar_color']
            update_last_seen(user['id'])
            return redirect(url_for('dashboard'))
        error = 'Invalid username / email or password.'
    return render_template('login.html', error=error)

@app.route('/register', methods=['GET','POST'])
def register():
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    error = None
    if request.method == 'POST':
        username     = request.form.get('username','').strip()
        email        = request.form.get('email','').strip()
        display_name = request.form.get('display_name','').strip()
        pw           = request.form.get('password','')
        pw2          = request.form.get('password2','')
        if not username or not email or not pw:
            error = 'All fields are required.'
        elif len(username) < 3:
            error = 'Username must be at least 3 characters.'
        elif pw != pw2:
            error = 'Passwords do not match.'
        elif len(pw) < 8:
            error = 'Password must be at least 8 characters.'
        else:
            try:
                create_user(username, email, display_name or username, pw)
                user = verify_user(username, pw)
                if user:
                    session['user_id']      = user['id']
                    session['username']     = user['username']
                    session['display_name'] = user['display_name']
                    session['avatar_color'] = user['avatar_color']
                    update_last_seen(user['id'])
                    return redirect(url_for('dashboard'))
                else:
                    error = 'Account created but login failed — please try signing in.'
            except psycopg2.errors.UniqueViolation:
                error = 'That username or email is already taken.'
            except Exception as e:
                print(f"[register] error: {e}")
                error = f'Registration failed: {str(e)}'
    return render_template('register.html', error=error)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# ═══════════════════════════════════════════════════════════════════
#  MESSAGING ROUTES
# ═══════════════════════════════════════════════════════════════════
@app.route('/api/messages/stream')
@login_required
def msg_stream():
    uid = session['user_id']
    q   = sse_subscribe(uid)
    def generate():
        try:
            while True:
                try:
                    yield q.get(timeout=20)
                except queue.Empty:
                    yield ': keepalive\n\n'
        finally:
            sse_unsubscribe(uid, q)
    return Response(stream_with_context(generate()), mimetype='text/event-stream',
                    headers={'Cache-Control':'no-cache','X-Accel-Buffering':'no',
                             'Connection':'keep-alive'})

@app.route('/api/messages/history')
@login_required
def msg_history():
    room = request.args.get('room','global')
    uid  = session['user_id']
    if room.startswith('dm_'):
        mark_dm_read(room, uid)
    return jsonify(get_room_messages(room, limit=80))

@app.route('/api/messages/send', methods=['POST'])
@login_required
def msg_send():
    data = request.get_json()
    body = (data.get('body') or '').strip()
    room = data.get('room','global')
    if not body or len(body) > 2000:
        return jsonify({'error':'Invalid message'}), 400
    uid    = session['user_id']
    sender = get_user_by_id(uid)
    update_last_seen(uid)
    recipient_id = None
    if room.startswith('dm_'):
        parts = room.split('_')
        ids   = [int(parts[1]), int(parts[2])]
        recipient_id = next((i for i in ids if i != uid), None)
    msg_id = save_message(uid, body, room, recipient_id)
    payload = {
        'type':'message','id':msg_id,'body':body,'room':room,
        'sent_at': datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S'),
        'username':sender['username'],'display_name':sender['display_name'],
        'avatar_color':sender['avatar_color'],
    }
    if room == 'global':
        sse_broadcast(payload, exclude_id=uid)
    elif recipient_id:
        sse_push(recipient_id, payload)
    return jsonify({'ok':True,'id':msg_id})

@app.route('/api/messages/users')
@login_required
def msg_users():
    uid   = session['user_id']
    users = get_all_users_except(uid)
    for u in users:
        room = get_dm_room(uid, u['id'])
        with get_db() as db:
            row = db.execute(
                "SELECT COUNT(*) as cnt FROM messages WHERE room=? AND recipient_id=? AND read=0",
                (room, uid)
            ).fetchone()
        u['unread'] = row['cnt'] if row else 0
    return jsonify(users)

# ═══════════════════════════════════════════════════════════════════
#  REDDIT ROUTES
# ═══════════════════════════════════════════════════════════════════
@app.route('/connect_reddit', methods=['GET','POST'])
@login_required
def connect_reddit():
    if request.method == 'POST':
        session['reddit_username'] = request.form.get('username')
        session['reddit_password'] = request.form.get('password')
        return redirect(url_for('dashboard'))
    return render_template('reddit_login.html',
                           theme_color=session.get('theme_color','#ff8c42'),
                           bg_color=session.get('bg_color','#fff5e6'))

@app.route('/disconnect_reddit')
@login_required
def disconnect_reddit():
    session.pop('reddit_username', None)
    session.pop('reddit_password', None)
    return redirect(url_for('dashboard'))

# ═══════════════════════════════════════════════════════════════════
#  DASHBOARD
# ═══════════════════════════════════════════════════════════════════
@app.route('/')
@login_required
def dashboard():
    uid         = session['user_id']
    city        = session.get('city','Charlotte')
    theme_color = session.get('theme_color','#ff8c42')
    bg_color    = session.get('bg_color','#fff5e6')
    insta_user  = "mmaatt24"

    gmail={'error':'Not connected'}; calendar={'error':'Not connected'}
    reddit_stats={'error':'Not connected'}; channel_ids=DEFAULT_CHANNELS

    if 'google_creds' in session:
        creds = Credentials.from_authorized_user_info(
            json.loads(session['google_creds']), SCOPES)
        gmail=get_gmail_unread(creds); calendar=get_calendar_events(creds)
        subs=get_youtube_subscriptions(creds)
        if subs: channel_ids=subs

    if session.get('reddit_username'):
        reddit_stats = get_reddit_stats()

    update_last_seen(uid)
    return render_template(
        'dashboard.html',
        instagram    = get_instagram_followers(insta_user),
        weather      = get_weather(city),
        datetime     = get_date_time(),
        news         = get_news(),
        social_feed  = get_unified_feed(channel_ids, insta_user),
        bank_accounts= get_bank_accounts(),
        gmail        = gmail,
        calendar     = calendar,
        reddit_stats = reddit_stats,
        maps_api_key = GOOGLE_MAPS_API_KEY,
        theme_color  = theme_color,
        bg_color     = bg_color,
        current_user = get_user_by_id(uid),
        all_users    = get_all_users_except(uid),
        dm_unread    = unread_count(uid),
    )

if __name__ == '__main__':
    app.run(debug=True, port=5002, threaded=True)