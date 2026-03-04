/**
 * ════════════════════════════════════════════════════════════════
 *  ASHFALL – Post-Apocalyptic Pixel Battle Royale
 *  game.js  |  Single-file game engine
 *
 *  HOW TO RUN:
 *    Open index.html in any modern browser (Chrome/Firefox/Edge).
 *    No server, no build step required.
 *
 *  ARCHITECTURE (multiplayer-ready):
 *    - All game state lives in GameManager
 *    - Input is abstracted in InputManager (swap for network later)
 *    - Entity classes are pure logic – no DOM coupling
 *
 *  CLASSES:
 *    GameManager, World, Tile, Camera, InputManager,
 *    Entity, Player, Bot, Animal, Projectile,
 *    Weapon, Loot, Particle, SoundManager, HUD
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

// ─── CONSTANTS ──────────────────────────────────────────────────
const TILE     = 32;           // px per tile
const MAP_W    = 128;          // tiles wide
const MAP_H    = 80;           // tiles tall
const GRAVITY  = 0.45;        // default gravity (pixels/frame²)
const LAVA_DMG = 8;            // damage per frame in lava
const NUM_BOTS = 7;
const ZONE_SHRINK_START = 30;  // seconds before zone starts shrinking
const ZONE_SHRINK_TIME  = 90;  // seconds to fully close
const ZONE_DMG = 3;            // damage per frame outside zone

// Tile type IDs
const T = {
  AIR:   0, GROUND: 1, GRASS: 2, STONE: 3,
  LAVA:  4, RUIN:   5, WOOD:  6, METAL: 7,
  GRAV:  8  // gravity-shift zone
};

// Pixel-art color palettes
const TILE_COLORS = {
  [T.AIR]:    null,
  [T.GROUND]: ['#5a4a30','#6b5a3a','#4a3a20'],
  [T.GRASS]:  ['#3a6b2a','#4a7b3a','#2a5a1a'],
  [T.STONE]:  ['#555566','#666677','#444455'],
  [T.LAVA]:   ['#ff4400','#ff6600','#ff2200','#ff8800'],
  [T.RUIN]:   ['#887766','#776655','#998877'],
  [T.WOOD]:   ['#8b5e3c','#7a4e2c','#9b6e4c'],
  [T.METAL]:  ['#778899','#667788','#889900'],
  [T.GRAV]:   ['#aa00ff','#8800cc','#cc22ff'],
};

// Weapon definitions
const WEAPON_DEFS = {
  knife:    { name:'KNIFE',   type:'melee',  dmg:25,  range:50,   rof:300,  reload:0,    magSize:0,   ammoType:'none',    icon:'🔪', color:'#aaa' },
  pistol:   { name:'PISTOL',  type:'ranged', dmg:30,  range:400,  rof:400,  reload:1200, magSize:12,  ammoType:'pistol',  icon:'🔫', color:'#ccc', spread:0.05 },
  shotgun:  { name:'SHOTGUN', type:'ranged', dmg:20,  range:200,  rof:900,  reload:2000, magSize:6,   ammoType:'shells',  icon:'⚡', color:'#da0', spread:0.2,  pellets:6 },
  ar:       { name:'AR-15',   type:'ranged', dmg:22,  range:600,  rof:120,  reload:2000, magSize:30,  ammoType:'rifle',   icon:'🔧', color:'#8f8', spread:0.08 },
  sniper:   { name:'SNIPER',  type:'ranged', dmg:95,  range:1200, rof:2000, reload:3000, magSize:5,   ammoType:'rifle',   icon:'🎯', color:'#f88', spread:0.01 },
};

// Animal definitions
const ANIMAL_DEFS = {
  wolf:  { name:'Wolf',    hp:60,  spd:2.2, dmg:15, aggroRange:200, color:'#778', w:28, h:20, loot:'pistol',  dropChance:0.3 },
  lizard:{ name:'LavaLizard', hp:80, spd:1.6, dmg:20, aggroRange:250, color:'#f60', w:30, h:18, loot:'shells', dropChance:0.4, ranged:true },
  bird:  { name:'GiantBird',  hp:50, spd:3.0, dmg:18, aggroRange:300, color:'#558', w:32, h:24, loot:'rifle',  dropChance:0.25, flying:true },
  boar:  { name:'ArmoredBoar',hp:150, spd:1.8, dmg:30, aggroRange:180, color:'#643', w:40, h:28, loot:'armor',  dropChance:0.5, charge:true },
};

// ─── UTILITIES ──────────────────────────────────────────────────
const rnd  = (a,b) => a + Math.random()*(b-a);
const rndi = (a,b) => Math.floor(rnd(a,b));
const clamp = (v,lo,hi) => Math.max(lo, Math.min(hi, v));
const dist  = (a,b) => Math.hypot(a.x-b.x, a.y-b.y);
const lerp  = (a,b,t) => a+(b-a)*t;

// ─── SOUND MANAGER (Web Audio, synthesized retro SFX) ────────────
class SoundManager {
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) { this.ctx = null; }
  }
  _play(freq, type='square', dur=0.1, vol=0.15, decay=0.08) {
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const g   = this.ctx.createGain();
      osc.connect(g); g.connect(this.ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq*0.5, this.ctx.currentTime+dur);
      g.gain.setValueAtTime(vol, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime+dur+decay);
      osc.start(); osc.stop(this.ctx.currentTime+dur+decay+0.05);
    } catch(e){}
  }
  shoot()   { this._play(800,'square',0.05,0.1); }
  reload()  { this._play(200,'triangle',0.3,0.08); }
  pickup()  { this._play(600,'sine',0.12,0.1); this._play(900,'sine',0.08,0.08); }
  hit()     { this._play(150,'sawtooth',0.06,0.12); }
  die()     { this._play(80,'sawtooth',0.4,0.15,0.3); }
  melee()   { this._play(300,'square',0.05,0.1); }
  step()    { this._play(rnd(80,120),'triangle',0.03,0.04); }
  resume()  { if (this.ctx && this.ctx.state==='suspended') this.ctx.resume(); }
}

// ─── INPUT MANAGER ──────────────────────────────────────────────
class InputManager {
  constructor(canvas) {
    this.keys    = {};
    this.mouse   = { x:0, y:0, down:false, justDown:false };
    this._mouse  = { x:0, y:0 };
    this.canvas  = canvas;
    document.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (['Space','ArrowUp','ArrowDown'].includes(e.code)) e.preventDefault();
    });
    document.addEventListener('keyup', e => { this.keys[e.code] = false; });
    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width;
      const sy = canvas.height / r.height;
      this._mouse.x = (e.clientX - r.left) * sx;
      this._mouse.y = (e.clientY - r.top)  * sy;
    });
    canvas.addEventListener('mousedown', e => {
      if (e.button===0) { this.mouse.down = true; this.mouse.justDown = true; }
    });
    canvas.addEventListener('mouseup', e => {
      if (e.button===0) this.mouse.down = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }
  update(camera) {
    this.mouse.x = this._mouse.x + camera.x;
    this.mouse.y = this._mouse.y + camera.y;
  }
  flush() {
    this.mouse.justDown = false;
  }
  key(code) { return !!this.keys[code]; }
  pressed(code) {
    if (this.keys['_pressed_'+code]) return false;
    if (this.keys[code]) { this.keys['_pressed_'+code]=true; return true; }
    if (!this.keys[code]) this.keys['_pressed_'+code]=false;
    return false;
  }
}

// ─── CAMERA ─────────────────────────────────────────────────────
class Camera {
  constructor(vw, vh) {
    this.x=0; this.y=0;
    this.vw=vw; this.vh=vh;
    this.shake=0;
    this.ox=0; this.oy=0;
  }
  follow(target) {
    const tx = target.x - this.vw/2;
    const ty = target.y - this.vh/2;
    this.x = lerp(this.x, tx, 0.1);
    this.y = lerp(this.y, ty, 0.1);
    this.x = clamp(this.x, 0, MAP_W*TILE - this.vw);
    this.y = clamp(this.y, 0, MAP_H*TILE - this.vh);
  }
  addShake(amt) { this.shake = Math.max(this.shake, amt); }
  update() {
    if (this.shake > 0) {
      this.ox = rnd(-this.shake, this.shake);
      this.oy = rnd(-this.shake, this.shake);
      this.shake *= 0.85;
      if (this.shake < 0.5) this.shake = 0;
    } else { this.ox=0; this.oy=0; }
  }
  toScreen(wx, wy) { return { x: wx - this.x + this.ox, y: wy - this.y + this.oy }; }
  inView(wx, wy, w=32, h=32) {
    return wx+w > this.x && wx < this.x+this.vw &&
           wy+h > this.y && wy < this.y+this.vh;
  }
}

// ─── WORLD / TILEMAP ────────────────────────────────────────────
class World {
  constructor() {
    this.tiles = [];
    this.generate();
  }

  generate() {
    // Initialize to air
    this.tiles = Array.from({length:MAP_H}, ()=>new Uint8Array(MAP_W));

    // Ground layer (Perlin-like using sine waves)
    const groundHeight = new Float32Array(MAP_W);
    for (let x=0; x<MAP_W; x++) {
      groundHeight[x] = Math.floor(
        MAP_H*0.6
        + Math.sin(x*0.07)*6
        + Math.sin(x*0.13+1)*4
        + Math.sin(x*0.03+2)*10
      );
    }

    // Place tiles
    for (let x=0; x<MAP_W; x++) {
      const gh = groundHeight[x];
      for (let y=0; y<MAP_H; y++) {
        if (y === gh) this.tiles[y][x] = T.GRASS;
        else if (y > gh && y < gh+4) this.tiles[y][x] = T.GROUND;
        else if (y >= gh+4) this.tiles[y][x] = T.STONE;
      }
    }

    // Lava rivers in valleys
    for (let x=2; x<MAP_W-2; x++) {
      const gh = groundHeight[x];
      // Low spots become lava lakes
      if (gh > MAP_H*0.65) {
        for (let d=0; d<3; d++) {
          if (gh+d < MAP_H) this.tiles[gh+d][x] = T.LAVA;
        }
      }
    }

    // Ruins – broken building clusters
    for (let i=0; i<20; i++) {
      const bx = rndi(5, MAP_W-15);
      const by = groundHeight[bx+4] - rndi(4, 10);
      const bw = rndi(4, 10);
      const bh = rndi(3, 8);
      for (let r=0; r<bh; r++) {
        for (let c=0; c<bw; c++) {
          const tx2 = bx+c, ty2 = by+r;
          if (ty2>=0 && ty2<MAP_H && tx2>=0 && tx2<MAP_W && this.tiles[ty2][tx2]===T.AIR) {
            // Ruin walls with holes
            const isWall = r===0 || r===bh-1 || c===0 || c===bw-1;
            if (isWall && Math.random() > 0.25) {
              this.tiles[ty2][tx2] = Math.random()>0.5 ? T.RUIN : T.METAL;
            }
          }
        }
      }
      // Floor
      const by2 = by+bh;
      for (let c=0; c<bw; c++) {
        const tx2=bx+c;
        if (by2>=0 && by2<MAP_H && tx2>=0 && tx2<MAP_W)
          this.tiles[by2][tx2] = T.RUIN;
      }
    }

    // Floating platforms
    for (let i=0; i<30; i++) {
      const px = rndi(4, MAP_W-8);
      const py = rndi(5, MAP_H-20);
      const pw = rndi(3, 7);
      if (this.tiles[py][px]===T.AIR) {
        for (let c=0; c<pw; c++) {
          if (px+c < MAP_W) {
            this.tiles[py][px+c] = T.STONE;
            this.tiles[py+1][px+c] = T.GROUND;
          }
        }
      }
    }

    // Gravity-shift zones (purple tiles)
    for (let i=0; i<8; i++) {
      const gx = rndi(5, MAP_W-5);
      const gy = rndi(5, MAP_H-5);
      for (let r=-1; r<=1; r++) for (let c=-1; c<=1; c++) {
        const tx2=gx+c, ty2=gy+r;
        if (tx2>=0&&tx2<MAP_W&&ty2>=0&&ty2<MAP_H&&this.tiles[ty2][tx2]===T.AIR)
          this.tiles[ty2][tx2] = T.GRAV;
      }
    }
  }

  getTile(tx, ty) {
    if (tx<0||tx>=MAP_W||ty<0||ty>=MAP_H) return T.STONE;
    return this.tiles[ty][tx];
  }
  isSolid(tx, ty) {
    const t = this.getTile(tx, ty);
    return t===T.GROUND||t===T.GRASS||t===T.STONE||t===T.RUIN||t===T.WOOD||t===T.METAL;
  }
  isLava(tx, ty)  { return this.getTile(tx, ty)===T.LAVA; }
  isGrav(tx, ty)  { return this.getTile(tx, ty)===T.GRAV; }

  /** Shoot a ray; returns {hit, x, y, nx, ny} */
  raycast(x, y, dx, dy, maxDist) {
    let len = 0;
    const step = 4;
    dx = dx / Math.hypot(dx,dy) * step;
    dy = dy / Math.hypot(dx||1,dy||1) * step;
    // recalculate after step scale
    const mag = Math.hypot(dx,dy);
    while (len < maxDist) {
      x += dx; y += dy; len += step;
      const tx = Math.floor(x/TILE), ty = Math.floor(y/TILE);
      if (this.isSolid(tx,ty)) return { hit:true, x, y };
    }
    return { hit:false, x, y };
  }

  draw(ctx, camera) {
    const startX = Math.max(0, Math.floor(camera.x/TILE)-1);
    const startY = Math.max(0, Math.floor(camera.y/TILE)-1);
    const endX   = Math.min(MAP_W, startX + Math.ceil(camera.vw/TILE)+2);
    const endY   = Math.min(MAP_H, startY + Math.ceil(camera.vh/TILE)+2);

    for (let ty=startY; ty<endY; ty++) {
      for (let tx=startX; tx<endX; tx++) {
        const t = this.tiles[ty][tx];
        if (t===T.AIR) continue;
        const colors = TILE_COLORS[t];
        if (!colors) continue;

        const sx = tx*TILE - camera.x + camera.ox;
        const sy = ty*TILE - camera.y + camera.oy;

        // Lava animation
        if (t===T.LAVA) {
          const fi = Math.floor(Date.now()/300 + tx + ty) % colors.length;
          ctx.fillStyle = colors[fi];
        } else {
          // Deterministic shade from position
          ctx.fillStyle = colors[(tx*3+ty*7)%colors.length];
        }
        ctx.fillRect(sx, sy, TILE, TILE);

        // Pixel detail: darker border
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(sx, sy, TILE, 1);
        ctx.fillRect(sx, sy, 1, TILE);

        // Grav zone shimmer
        if (t===T.GRAV) {
          ctx.fillStyle = `rgba(170,0,255,${0.2+Math.sin(Date.now()*0.005+tx+ty)*0.15})`;
          ctx.fillRect(sx,sy,TILE,TILE);
        }
        // Lava glow
        if (t===T.LAVA) {
          ctx.fillStyle = `rgba(255,100,0,${0.3+Math.sin(Date.now()*0.008+tx)*0.2})`;
          ctx.fillRect(sx, sy, TILE, 4);
        }
      }
    }
  }
}

// ─── WEAPON CLASS ───────────────────────────────────────────────
class Weapon {
  constructor(type) {
    const def = WEAPON_DEFS[type] || WEAPON_DEFS.knife;
    Object.assign(this, def);
    this.type_key   = type;
    this.ammo       = this.magSize;
    this.totalAmmo  = this.magSize * 3;
    this.lastShot   = 0;
    this.reloading  = false;
    this.reloadEnd  = 0;
  }

  canFire(now) {
    if (this.reloading && now >= this.reloadEnd) this.reloading = false;
    if (this.reloading) return false;
    if (this.type==='melee') return now - this.lastShot >= this.rof;
    return this.ammo > 0 && now - this.lastShot >= this.rof;
  }

  startReload(now, snd) {
    if (this.type==='melee'||this.reloading||this.ammo===this.magSize||this.totalAmmo===0) return;
    this.reloading = true;
    this.reloadEnd = now + this.reload;
    if(snd) snd.reload();
  }

  fire(now) {
    this.lastShot = now;
    if (this.type!=='melee') {
      this.ammo--;
      if (this.ammo<=0) {
        const refill = Math.min(this.magSize, this.totalAmmo);
        // auto-reload state
        this.reloading = true;
        this.reloadEnd = now + this.reload;
      }
    }
  }

  addAmmo(amount) { this.totalAmmo = Math.min(this.totalAmmo + amount, this.magSize*5); }

  get reloadProgress() {
    const now = Date.now();
    if (!this.reloading) return 1;
    return clamp((now - (this.reloadEnd-this.reload)) / this.reload, 0, 1);
  }

  /** Complete reload at end of reload timer */
  updateReload(now) {
    if (this.reloading && now >= this.reloadEnd) {
      const refill = Math.min(this.magSize - this.ammo, this.totalAmmo);
      this.ammo      += refill;
      this.totalAmmo -= refill;
      this.reloading  = false;
    }
  }
}

// ─── PROJECTILE ─────────────────────────────────────────────────
class Projectile {
  constructor(x, y, dx, dy, dmg, owner, speed=14) {
    this.x = x; this.y = y;
    const mag = Math.hypot(dx, dy)||1;
    this.dx = (dx/mag)*speed;
    this.dy = (dy/mag)*speed;
    this.dmg   = dmg;
    this.owner = owner;
    this.alive = true;
    this.trail = [];
  }
  update(world) {
    this.trail.push({x:this.x, y:this.y});
    if (this.trail.length > 6) this.trail.shift();
    this.x += this.dx; this.y += this.dy;
    const tx = Math.floor(this.x/TILE), ty = Math.floor(this.y/TILE);
    if (world.isSolid(tx,ty)||this.x<0||this.y<0||this.x>MAP_W*TILE||this.y>MAP_H*TILE) {
      this.alive = false;
    }
  }
  draw(ctx, camera) {
    if (!camera.inView(this.x-4,this.y-4,8,8)) return;
    // Trail
    for (let i=0; i<this.trail.length; i++) {
      const t = this.trail[i];
      const alpha = i/this.trail.length*0.5;
      ctx.fillStyle = `rgba(255,200,80,${alpha})`;
      const s = camera.toScreen(t.x, t.y);
      ctx.fillRect(s.x-1, s.y-1, 2, 2);
    }
    const s = camera.toScreen(this.x, this.y);
    ctx.fillStyle = '#ffe080';
    ctx.fillRect(s.x-2, s.y-2, 4, 4);
  }
}

// ─── LOOT ITEM ──────────────────────────────────────────────────
class Loot {
  constructor(x, y, kind, amount=1) {
    this.x=x; this.y=y;
    this.kind=kind;     // 'pistol','shotgun','ar','sniper','pistol_ammo','shells','rifle','armor','heal','knife'
    this.amount=amount;
    this.alive=true;
    this.bob=Math.random()*Math.PI*2;
  }
  update() { this.bob += 0.06; }
  draw(ctx, camera) {
    if (!camera.inView(this.x-12,this.y-12,24,24)) return;
    const s  = camera.toScreen(this.x, this.y);
    const by = Math.sin(this.bob)*3;
    // Shadow
    ctx.fillStyle='rgba(0,0,0,0.3)';
    ctx.fillRect(s.x-10, s.y+14, 20, 4);
    // Box
    const lootColors = {
      pistol:'#bbb', shotgun:'#da0', ar:'#8f8', sniper:'#f88',
      pistol_ammo:'#eee', shells:'#fc0', rifle:'#aff',
      armor:'#44f', heal:'#f44', knife:'#aaa'
    };
    ctx.fillStyle = lootColors[this.kind] || '#fff';
    ctx.fillRect(s.x-8, s.y+by-8, 16, 16);
    ctx.fillStyle='rgba(255,255,255,0.4)';
    ctx.fillRect(s.x-8, s.y+by-8, 16, 4);
    // Glow
    ctx.fillStyle=lootColors[this.kind]||'#fff';
    ctx.globalAlpha=0.15+Math.sin(this.bob)*0.1;
    ctx.fillRect(s.x-12, s.y+by-12, 24, 24);
    ctx.globalAlpha=1;
  }
  labelStr() {
    const labels = {
      pistol:'PISTOL',shotgun:'SHOTGUN',ar:'AR-15',sniper:'SNIPER',
      pistol_ammo:'PISTOL AMMO',shells:'SHELLS',rifle:'RIFLE AMMO',
      armor:'ARMOR',heal:'MEDKIT',knife:'KNIFE'
    };
    return labels[this.kind]||this.kind.toUpperCase();
  }
}

// ─── PARTICLE ───────────────────────────────────────────────────
class Particle {
  constructor(x,y,dx,dy,color,life=30,size=3) {
    this.x=x; this.y=y;
    this.dx=dx; this.dy=dy;
    this.color=color;
    this.life=life; this.maxLife=life;
    this.size=size;
    this.alive=true;
  }
  update(grav=0.2) {
    this.dy+=grav;
    this.x+=this.dx; this.y+=this.dy;
    this.life--;
    if(this.life<=0) this.alive=false;
  }
  draw(ctx,camera) {
    const s=camera.toScreen(this.x,this.y);
    const alpha=this.life/this.maxLife;
    ctx.globalAlpha=alpha;
    ctx.fillStyle=this.color;
    ctx.fillRect(s.x,s.y,this.size,this.size);
    ctx.globalAlpha=1;
  }
}

function spawnBlood(arr, x, y, n=8) {
  for(let i=0;i<n;i++) {
    arr.push(new Particle(x,y,rnd(-3,3),rnd(-4,0),'#cc2200',rnd(15,30),rndi(2,5)));
    arr.push(new Particle(x,y,rnd(-2,2),rnd(-3,-1),'#ff4422',rnd(10,20),2));
  }
}
function spawnLavaParticles(arr, x, y) {
  for(let i=0;i<4;i++)
    arr.push(new Particle(x,y,rnd(-2,2),rnd(-4,-1),'#ff6600',rnd(10,25),3));
}

// ─── BASE ENTITY ────────────────────────────────────────────────
class Entity {
  constructor(x,y,w,h) {
    this.x=x; this.y=y; this.w=w; this.h=h;
    this.vx=0; this.vy=0;
    this.onGround=false;
    this.alive=true;
    this.gravMult=1; // modified in gravity zones
  }

  /** Simple AABB collision with tilemap */
  moveAndCollide(world) {
    // Horizontal
    this.x += this.vx;
    if (this._collidedH(world)) {
      this.vx = 0;
    }
    // Vertical
    this.y += this.vy;
    this.onGround = false;
    if (this._collidedV(world)) {
      if (this.vy > 0) this.onGround = true;
      this.vy = 0;
    }
  }

  _collidedH(world) {
    const left  = Math.floor(this.x/TILE);
    const right = Math.floor((this.x+this.w-1)/TILE);
    const top   = Math.floor(this.y/TILE);
    const bot   = Math.floor((this.y+this.h-2)/TILE);
    for (let ty=top; ty<=bot; ty++) {
      if (world.isSolid(left,ty)||world.isSolid(right,ty)) {
        if (this.vx > 0) this.x = right*TILE - this.w;
        else if (this.vx < 0) this.x = (left+1)*TILE;
        return true;
      }
    }
    return false;
  }

  _collidedV(world) {
    const left  = Math.floor((this.x+1)/TILE);
    const right = Math.floor((this.x+this.w-2)/TILE);
    const top   = Math.floor(this.y/TILE);
    const bot   = Math.floor((this.y+this.h)/TILE);
    for (let tx=left; tx<=right; tx++) {
      if (world.isSolid(tx, bot)) { this.y = bot*TILE - this.h; return true; }
      if (world.isSolid(tx, top)) { this.y = (top+1)*TILE;       return true; }
    }
    return false;
  }

  applyGravity(world) {
    const cx = Math.floor((this.x+this.w/2)/TILE);
    const cy = Math.floor((this.y+this.h/2)/TILE);
    this.gravMult = world.isGrav(cx,cy) ? 0.4 : 1;
    this.vy += GRAVITY * this.gravMult;
    this.vy  = clamp(this.vy, -20, 18);
  }

  inLava(world) {
    const cx = Math.floor((this.x+this.w/2)/TILE);
    const cy = Math.floor((this.y+this.h/2)/TILE);
    return world.isLava(cx,cy)||world.isLava(cx,cy+1);
  }

  get cx() { return this.x + this.w/2; }
  get cy() { return this.y + this.h/2; }
  get feet() { return this.y + this.h; }

  overlaps(other) {
    return this.x < other.x+other.w && this.x+this.w > other.x &&
           this.y < other.y+other.h && this.y+this.h > other.y;
  }
}

// ─── PLAYER (Human or Bot inherits this) ────────────────────────
class Player extends Entity {
  constructor(x, y, name='Player', isHuman=false) {
    super(x, y, 20, 28);
    this.name    = name;
    this.isHuman = isHuman;
    this.hp      = 100; this.maxHp = 100;
    this.armor   = 0;   this.maxArmor = 100;
    this.kills   = 0;
    this.dead    = false;

    // Inventory: 5 slots, slot 0 = knife always
    this.inventory   = [new Weapon('knife'), null, null, null, null];
    this.activeSlot  = 0;
    this.facing      = 1; // 1=right, -1=left

    this.stepTimer   = 0;
    this.attackAnim  = 0; // frames of attack animation
    this.color       = isHuman ? '#4af' : `hsl(${rndi(0,360)},60%,55%)`;
    this.hat         = rndi(0,4); // cosmetic hat type

    // For bot / AI use
    this.aiState     = 'idle';
    this.aiTarget    = null;
    this.aiTimer     = 0;
    this.fleeing     = false;
  }

  get weapon() { return this.inventory[this.activeSlot]; }

  takeDamage(dmg, attacker) {
    if (this.dead) return;
    let effective = dmg;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.6);
      this.armor     = Math.max(0, this.armor - absorbed);
      effective     -= absorbed;
    }
    this.hp = Math.max(0, this.hp - effective);
    if (this.hp <= 0) this.die(attacker);
  }

  die(killer) {
    if (this.dead) return;
    this.dead  = true;
    this.alive = false;
    if (killer && killer.kills !== undefined) killer.kills++;
  }

  heal(amount) { this.hp = Math.min(this.maxHp, this.hp + amount); }

  addWeapon(type) {
    // Find empty slot
    for (let i=1;i<5;i++) {
      if (!this.inventory[i]) { this.inventory[i]=new Weapon(type); this.activeSlot=i; return true; }
    }
    // Replace active slot if not knife
    if (this.activeSlot!==0) { this.inventory[this.activeSlot]=new Weapon(type); return true; }
    return false;
  }

  selectSlot(n) {
    if (n>=0&&n<5&&this.inventory[n]) this.activeSlot=n;
  }

  /** Returns array of new Projectiles (or empty for melee) */
  fireWeapon(targetX, targetY, snd) {
    const w = this.weapon;
    if (!w) return [];
    const now = Date.now();
    if (!w.canFire(now)) return [];
    w.fire(now);

    const cx = this.cx, cy = this.cy - 4;
    const projs = [];

    if (w.type==='melee') {
      if(snd) snd.melee();
      this.attackAnim = 10;
      // Return a "melee marker" object
      projs.push({ isMelee:true, x:cx, y:cy, range:w.range, dmg:w.dmg, owner:this });
    } else {
      if(snd) snd.shoot();
      const pellets = w.pellets || 1;
      for (let p=0; p<pellets; p++) {
        let dx = targetX - cx;
        let dy = targetY - cy;
        // Add spread
        dx += rnd(-1,1)*w.spread*100;
        dy += rnd(-1,1)*w.spread*100;
        projs.push(new Projectile(cx, cy, dx, dy, w.dmg, this));
      }
    }
    return projs;
  }

  jump(custom) {
    if (this.onGround) {
      this.vy = custom || (this.gravMult < 0.6 ? -13 : -10);
    }
  }

  update(world) {
    if (this.dead) return;
    this.applyGravity(world);
    this.moveAndCollide(world);

    // Lava damage
    if (this.inLava(world)) this.takeDamage(LAVA_DMG);

    // Update weapon reload
    if (this.weapon) this.weapon.updateReload(Date.now());

    // Step sound timer
    if (Math.abs(this.vx)>0.5 && this.onGround) this.stepTimer++;

    // Friction
    this.vx *= 0.78;
    if (Math.abs(this.vx)<0.1) this.vx=0;

    if (this.attackAnim>0) this.attackAnim--;
  }

  draw(ctx, camera) {
    if (!this.alive && this.dead) return;
    if (!camera.inView(this.x, this.y, this.w, this.h)) return;
    const s = camera.toScreen(this.x, this.y);
    const f = this.facing;

    // Shadow
    ctx.fillStyle='rgba(0,0,0,0.3)';
    ctx.fillRect(s.x, s.y+this.h, this.w, 4);

    // Body
    ctx.fillStyle=this.color;
    ctx.fillRect(s.x+2, s.y+10, this.w-4, this.h-10);

    // Head
    ctx.fillStyle=this.isHuman ? '#f5d0a0' : '#e0c080';
    ctx.fillRect(s.x+4, s.y, this.w-8, 12);

    // Eyes
    ctx.fillStyle='#111';
    const eyeX = f>0 ? s.x+this.w-8 : s.x+4;
    ctx.fillRect(eyeX, s.y+3, 3, 3);

    // Hat
    const hatColors=['#222','#8b4513','#1a1aff','#228b22'];
    ctx.fillStyle=hatColors[this.hat];
    ctx.fillRect(s.x+2, s.y-5, this.w-4, 6);

    // Legs (simple animation)
    const legAnim = Math.sin(Date.now()*0.015)*5;
    ctx.fillStyle='#444';
    if (this.onGround && Math.abs(this.vx)>0.3) {
      ctx.fillRect(s.x+2, s.y+this.h-8, 7, 8+legAnim);
      ctx.fillRect(s.x+this.w-9, s.y+this.h-8, 7, 8-legAnim);
    } else {
      ctx.fillRect(s.x+2, s.y+this.h-8, 7, 8);
      ctx.fillRect(s.x+this.w-9, s.y+this.h-8, 7, 8);
    }

    // Weapon graphic
    if (this.weapon && this.weapon.type==='ranged') {
      ctx.fillStyle=this.weapon.color||'#ccc';
      const wx = f>0 ? s.x+this.w-2 : s.x-10;
      ctx.fillRect(wx, s.y+14, 12, 5);
    }
    // Melee swing
    if (this.attackAnim>0 && this.weapon && this.weapon.type==='melee') {
      ctx.fillStyle='#ddd';
      const angle = (f>0?1:-1) * (this.attackAnim/10)*1.2;
      ctx.save();
      ctx.translate(s.x+this.w/2, s.y+this.h/2);
      ctx.rotate(angle);
      ctx.fillRect(0, -20, 4, 24);
      ctx.restore();
    }

    // Health bar
    const hpPct = this.hp/this.maxHp;
    ctx.fillStyle='#222';
    ctx.fillRect(s.x, s.y-8, this.w, 4);
    ctx.fillStyle = hpPct>0.5?'#3d3':'#d33';
    ctx.fillRect(s.x, s.y-8, this.w*hpPct, 4);

    // Reload bar
    if (this.weapon && this.weapon.reloading) {
      const rp = this.weapon.reloadProgress;
      ctx.fillStyle='#88f';
      ctx.fillRect(s.x, s.y-14, this.w*rp, 3);
    }

    // Name tag (bots)
    if (!this.isHuman) {
      ctx.fillStyle='rgba(0,0,0,0.5)';
      ctx.fillRect(s.x-4, s.y-22, this.w+8, 9);
      ctx.fillStyle='#fff';
      ctx.font='6px monospace';
      ctx.fillText(this.name, s.x, s.y-14);
    }
  }
}

// ─── BOT AI ─────────────────────────────────────────────────────
class Bot extends Player {
  constructor(x, y, id) {
    super(x, y, `BOT-${id}`, false);
    this.aiState  = 'roam';
    this.roamTarget = { x:x, y:y };
    this.reactTimer = 0;
    this.lastShootAt = 0;
  }

  updateAI(world, players, loots, projectiles, snd, camera, particles) {
    if (this.dead) return;
    this.reactTimer--;

    // Find nearest threat (player or animal)
    let nearestEnemy = null, nearestDist = 999999;
    for (const p of players) {
      if (p === this || p.dead) continue;
      const d = dist(this, p);
      if (d < nearestDist) { nearestDist=d; nearestEnemy=p; }
    }

    // Flee if low health
    if (this.hp < 25 && nearestEnemy && nearestDist < 400) {
      this.aiState = 'flee';
    } else if (nearestEnemy && nearestDist < 450) {
      this.aiState = 'fight';
    } else if (this.aiState !== 'loot') {
      this.aiState = 'roam';
    }

    // Look for nearby loot
    let bestLoot=null, bestLootDist=300;
    for (const l of loots) {
      if(!l.alive) continue;
      const ld = dist(this, l);
      // Prefer weapons we don't have
      const isWeapon = ['pistol','shotgun','ar','sniper'].includes(l.kind);
      const priority = isWeapon && !this.hasWeaponType(l.kind) ? 150 : 250;
      if (ld < Math.min(bestLootDist,priority)) { bestLoot=l; bestLootDist=ld; }
    }
    if (bestLoot && this.aiState !== 'fight') {
      this.aiState = 'loot';
      this.aiTarget = bestLoot;
    }

    // Execute state
    switch(this.aiState) {
      case 'roam':
        this._doRoam(world);
        break;
      case 'loot':
        if (!this.aiTarget||!this.aiTarget.alive) { this.aiState='roam'; break; }
        this._moveTo(this.aiTarget.x, world);
        if (dist(this,this.aiTarget)<40) {
          // pickup handled in GameManager
          this.aiTarget=null; this.aiState='roam';
        }
        break;
      case 'fight':
        if (!nearestEnemy) { this.aiState='roam'; break; }
        this.facing = nearestEnemy.cx > this.cx ? 1 : -1;
        // Select best weapon
        this._selectBestWeapon();
        const now=Date.now();
        if (nearestDist < 60 && this.weapon.type==='melee') {
          const attacks = this.fireWeapon(nearestEnemy.cx, nearestEnemy.cy, snd);
          this._handleAttacks(attacks, players, particles, camera, snd);
        } else if (nearestDist > 80 && nearestDist < 600) {
          // Move toward then shoot
          if (nearestDist > 150) this._moveTo(nearestEnemy.cx, world);
          if (now - this.lastShootAt > (this.weapon.rof||400)+rndi(0,200)) {
            const attacks = this.fireWeapon(nearestEnemy.cx, nearestEnemy.cy, snd);
            this._handleAttacks(attacks, players, particles, camera, snd);
            this.lastShootAt=now;
            // Add to global projectiles
            for(const a of attacks) if(!a.isMelee) projectiles.push(a);
          }
          // Dodge
          if (Math.random()<0.02) this.jump();
        } else if (nearestDist < 80) {
          this._moveTo(nearestEnemy.cx, world, -1); // back off
        }
        break;
      case 'flee':
        // Run away
        if (nearestEnemy) {
          const dir = this.cx < nearestEnemy.cx ? -1 : 1;
          this.vx = dir*3.5;
          this.facing = dir;
        }
        if (Math.random()<0.03) this.jump();
        if (!nearestEnemy||nearestDist>500) this.aiState='roam';
        break;
    }

    // Avoid lava: if in lava, jump hard
    if (this.inLava(world)) {
      this.jump(-12);
      this.vx = (Math.random()<0.5?1:-1)*4;
    }
  }

  hasWeaponType(type) {
    return this.inventory.some(w=>w&&w.type_key===type);
  }

  _selectBestWeapon() {
    const priority = ['sniper','ar','shotgun','pistol','knife'];
    for(const p of priority) {
      const idx = this.inventory.findIndex(w=>w&&w.type_key===p);
      if(idx>=0 && (this.inventory[idx].ammo>0||this.inventory[idx].type==='melee')) {
        this.activeSlot=idx; return;
      }
    }
  }

  _moveTo(tx, world, mult=1) {
    const dir = (tx > this.cx) ? 1 : -1;
    this.vx = dir * 2.8 * mult;
    this.facing = dir*mult>0?1:-1;
    // Jump obstacles
    const ahead = Math.floor((this.cx + dir*24)/TILE);
    const mid   = Math.floor(this.cy/TILE);
    if (world.isSolid(ahead, mid) && this.onGround) this.jump();
  }

  _doRoam(world) {
    if (Math.abs(this.cx - this.roamTarget.x) < 20 || Math.random()<0.01) {
      this.roamTarget.x = clamp(this.cx + rnd(-200,200), 50, MAP_W*TILE-50);
    }
    this._moveTo(this.roamTarget.x, world);
    if (Math.random()<0.005) this.jump();
  }

  _handleAttacks(attacks, players, particles, camera, snd) {
    for(const a of attacks) {
      if(a.isMelee) {
        for(const p of players) {
          if(p===this||p.dead) continue;
          if(dist(this,p)<a.range+this.w) {
            p.takeDamage(a.dmg, this);
            spawnBlood(particles, p.cx, p.cy);
            if(snd) snd.hit();
            camera.addShake(4);
          }
        }
      }
    }
  }
}

// ─── ANIMAL (Wildlife AI) ────────────────────────────────────────
class Animal extends Entity {
  constructor(x, y, type) {
    const def = ANIMAL_DEFS[type];
    super(x, y, def.w, def.h);
    Object.assign(this, def);
    this.type    = type;
    this.hp      = def.hp;
    this.state   = 'patrol';
    this.target  = null;
    this.stateTimer = 0;
    this.patrolDir = Math.random()<0.5?1:-1;
    this.attackCool= 0;
    this.flying    = def.flying||false;
    this.facing    = 1;
    this.lootDrop  = def.loot;
    this.dropChance= def.dropChance;
    this.isAnimal  = true;
    this.shootTimer= 0;
  }

  update(world, players, projectiles, snd) {
    if (!this.alive) return;
    this.stateTimer--;
    this.attackCool--;
    this.shootTimer--;

    // Find nearest player
    let nearest=null, nearDist=9999;
    for(const p of players) {
      if(p.dead) continue;
      const d=dist(this,p);
      if(d<nearDist){nearDist=d;nearest=p;}
    }

    // FSM
    switch(this.state) {
      case 'patrol':
        this.vx = this.patrolDir * (this.spd*0.5);
        this.facing = this.patrolDir;
        if(this.stateTimer<=0) { this.patrolDir*=-1; this.stateTimer=rndi(60,180); }
        if(nearest && nearDist<this.aggroRange) { this.state='aggro'; this.target=nearest; }
        break;

      case 'aggro':
        if(!nearest||nearDist>this.aggroRange*1.5) { this.state='patrol'; break; }
        this.target=nearest;
        this.facing = nearest.cx>this.cx?1:-1;
        this.vx = this.facing * this.spd;
        // Jump to reach
        if(this.onGround && nearest.y < this.y-20) this.vy=-9;

        // Ranged attack (lizard)
        if(this.ranged && nearDist<300 && this.shootTimer<=0) {
          const dx=nearest.cx-this.cx, dy=nearest.cy-this.cy;
          projectiles.push(new Projectile(this.cx,this.cy,dx,dy,this.dmg,this,8));
          this.shootTimer=60;
          if(snd) snd.shoot();
        }
        // Melee
        if(!this.ranged && nearDist<this.w+nearest.w && this.attackCool<=0) {
          nearest.takeDamage(this.dmg, this);
          this.attackCool=45;
          if(snd) snd.hit();
        }
        // Charge (boar)
        if(this.charge && nearDist<200) {
          this.vx = this.facing*this.spd*2.5;
        }
        break;
    }

    // Lava immunity for lizard
    if(!this.flying) {
      this.applyGravity(world);
      this.moveAndCollide(world);
      if(this.inLava(world) && this.type!=='lizard') this.takeDamage(LAVA_DMG);
    } else {
      // Flying: move toward target in 2D
      if(this.target && !this.target.dead) {
        const dx=this.target.cx-this.cx, dy=this.target.cy-this.cy;
        const m=Math.hypot(dx,dy)||1;
        this.x += dx/m * this.spd;
        this.y += dy/m * this.spd;
        // Swoop attack
        if(dist(this,this.target)<40 && this.attackCool<=0) {
          this.target.takeDamage(this.dmg, this);
          this.attackCool=50;
          if(snd) snd.hit();
        }
      } else { this.x += this.patrolDir*this.spd*0.5; }
      this.x=clamp(this.x,0,MAP_W*TILE-this.w);
      this.y=clamp(this.y,0,MAP_H*TILE-this.h);
    }

    // Friction
    if(!this.flying) { this.vx*=0.8; }
  }

  takeDamage(dmg, killer) {
    this.hp-=dmg;
    if(this.hp<=0&&this.alive) { this.alive=false; }
  }

  draw(ctx, camera) {
    if(!this.alive||!camera.inView(this.x,this.y,this.w,this.h)) return;
    const s=camera.toScreen(this.x,this.y);
    const f=this.facing;

    // Body color
    ctx.fillStyle=this.color;
    ctx.fillRect(s.x, s.y, this.w, this.h);

    // Simple pixel detail
    ctx.fillStyle='rgba(0,0,0,0.3)';
    ctx.fillRect(s.x, s.y, this.w, 3);
    ctx.fillRect(s.x+(f>0?this.w-8:4), s.y+4, 5, 5);

    // Eye
    ctx.fillStyle='#ff0';
    ctx.fillRect(s.x+(f>0?this.w-6:3), s.y+5, 3, 3);

    // HP bar
    const hpPct=this.hp/ANIMAL_DEFS[this.type].hp;
    ctx.fillStyle='#222'; ctx.fillRect(s.x,s.y-6,this.w,3);
    ctx.fillStyle='#f80'; ctx.fillRect(s.x,s.y-6,this.w*hpPct,3);
  }
}

// ─── SAFE ZONE (Battle Royale Circle) ───────────────────────────
class SafeZone {
  constructor() {
    this.cx = MAP_W*TILE/2;
    this.cy = MAP_H*TILE/2;
    this.radius     = Math.max(MAP_W,MAP_H)*TILE*0.6;
    this.targetRadius = 80;
    this.shrinking  = false;
    this.startTime  = Date.now();
    this.phase      = 0;
  }

  update() {
    const elapsed = (Date.now()-this.startTime)/1000;
    if(elapsed > ZONE_SHRINK_START) {
      this.shrinking=true;
      const t = clamp((elapsed-ZONE_SHRINK_START)/ZONE_SHRINK_TIME, 0, 1);
      this.radius = lerp(MAP_W*TILE*0.6, this.targetRadius, t);
    }
  }

  isInside(x,y) {
    return Math.hypot(x-this.cx, y-this.cy) <= this.radius;
  }

  timeToShrink() {
    const elapsed=(Date.now()-this.startTime)/1000;
    return Math.max(0, ZONE_SHRINK_START-elapsed);
  }

  draw(ctx, camera) {
    const s = camera.toScreen(this.cx, this.cy);
    // Outside zone overlay (drawn as ring)
    ctx.save();
    ctx.beginPath();
    ctx.rect(camera.ox, camera.oy, camera.vw, camera.vh);
    ctx.arc(s.x, s.y, this.radius, 0, Math.PI*2, true);
    ctx.fillStyle='rgba(0,80,255,0.18)';
    ctx.fill();
    // Zone border
    ctx.beginPath();
    ctx.arc(s.x, s.y, this.radius, 0, Math.PI*2);
    ctx.strokeStyle='rgba(80,160,255,0.8)';
    ctx.lineWidth=3;
    ctx.stroke();
    ctx.restore();
  }
}

// ─── MINIMAP ─────────────────────────────────────────────────────
class Minimap {
  constructor(canvas, world, size=120) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.world   = world;
    this.size    = size;
    canvas.width = size; canvas.height = size;
    this._drawTerrain();
  }

  _drawTerrain() {
    const ctx = this.ctx;
    const sw  = this.size/MAP_W;
    const sh  = this.size/MAP_H;
    for(let y=0;y<MAP_H;y++) for(let x=0;x<MAP_W;x++) {
      const t=this.world.getTile(x,y);
      const colors={[T.AIR]:'#151210',[T.GROUND]:'#5a4a30',[T.GRASS]:'#3a6b2a',
                    [T.STONE]:'#555566',[T.LAVA]:'#ff4400',[T.RUIN]:'#887766',
                    [T.WOOD]:'#8b5e3c',[T.METAL]:'#778899',[T.GRAV]:'#8800cc'};
      ctx.fillStyle=colors[t]||'#151210';
      ctx.fillRect(x*sw, y*sh, sw+0.5, sh+0.5);
    }
  }

  draw(players, animals, zone) {
    const ctx=this.ctx;
    const sw=this.size/MAP_W;
    const sh=this.size/MAP_H;
    // Redraw terrain each frame (expensive but minimap is small)
    // Actually blit from cached; just draw entities
    this._drawTerrain();

    // Zone
    const zx=(zone.cx/(MAP_W*TILE))*this.size;
    const zy=(zone.cy/(MAP_H*TILE))*this.size;
    const zr=(zone.radius/(MAP_W*TILE))*this.size;
    ctx.beginPath();
    ctx.arc(zx,zy,zr,0,Math.PI*2);
    ctx.strokeStyle='rgba(80,160,255,0.8)'; ctx.lineWidth=1; ctx.stroke();

    // Animals
    for(const a of animals) {
      if(!a.alive) continue;
      ctx.fillStyle='#f80';
      ctx.fillRect((a.x/(MAP_W*TILE))*this.size-1,(a.y/(MAP_H*TILE))*this.size-1,2,2);
    }
    // Players
    for(const p of players) {
      if(p.dead) continue;
      ctx.fillStyle = p.isHuman ? '#4af' : '#f44';
      const mx=(p.x/(MAP_W*TILE))*this.size;
      const my=(p.y/(MAP_H*TILE))*this.size;
      ctx.fillRect(mx-2,my-2,4,4);
    }
  }
}

// ─── HUD MANAGER ────────────────────────────────────────────────
class HUD {
  constructor() {
    this.hpBar      = document.getElementById('hp-bar');
    this.armorBar   = document.getElementById('armor-bar');
    this.weaponName = document.getElementById('weapon-name');
    this.ammoDisp   = document.getElementById('ammo-display');
    this.killFeed   = document.getElementById('kill-feed');
    this.zoneTimer  = document.getElementById('zone-timer');
    this.aliveNum   = document.getElementById('alive-num');
    this.invSlots   = document.querySelectorAll('.inv-slot');
    this.pickupPrompt = document.getElementById('pickup-prompt');
    this.invIcons   = document.querySelectorAll('.inv-icon');
    this.kills      = [];
  }

  update(player, zone, aliveCount, nearLoot) {
    this.hpBar.style.width    = `${(player.hp/player.maxHp)*100}%`;
    this.armorBar.style.width = `${(player.armor/player.maxArmor)*100}%`;
    this.hpBar.style.background = player.hp > 40 ? '#22dd44' : '#dd2222';

    const w = player.weapon;
    this.weaponName.textContent = w ? w.name : 'NONE';
    this.ammoDisp.textContent   = w && w.type==='ranged'
      ? `${w.ammo} / ${w.totalAmmo}`
      : (w && w.reloading ? 'RELOADING…' : '∞');

    // Zone
    const t2s = zone.timeToShrink();
    this.zoneTimer.textContent = t2s > 0
      ? `ZONE SAFE ${Math.ceil(t2s)}s`
      : `☢ ZONE SHRINKING`;
    this.zoneTimer.style.color = t2s > 0 ? '#22dd44' : '#ff4400';

    this.aliveNum.textContent = aliveCount;

    // Inventory bar
    const weaponIcons = {knife:'🔪',pistol:'🔫',shotgun:'⚡',ar:'🔧',sniper:'🎯',null:'—'};
    this.invSlots.forEach((slot,i) => {
      slot.classList.toggle('active', i===player.activeSlot);
      const w2 = player.inventory[i];
      this.invIcons[i].textContent = w2 ? (weaponIcons[w2.type_key]||'?') : '—';
    });

    // Pickup prompt
    if(nearLoot) {
      this.pickupPrompt.classList.remove('hidden');
      this.pickupPrompt.querySelector('b') && (this.pickupPrompt.innerHTML=`Press <b>E</b> to pick up <span style="color:#fc0">${nearLoot.labelStr()}</span>`);
    } else {
      this.pickupPrompt.classList.add('hidden');
    }
  }

  addKill(msg) {
    const el = document.createElement('div');
    el.className='kill-entry';
    el.textContent=msg;
    this.killFeed.appendChild(el);
    setTimeout(()=>el.remove(), 4000);
  }

  showGameOver(rank, totalPlayers, kills) {
    document.getElementById('gameover-screen').classList.add('active');
    document.getElementById('go-rank').textContent  = `RANK: #${rank} / ${totalPlayers}`;
    document.getElementById('go-stats').innerHTML   = `KILLS: ${kills}`;
  }

  showWin(kills) {
    document.getElementById('win-screen').classList.add('active');
    document.getElementById('win-stats').innerHTML  = `KILLS: ${kills}`;
  }
}

// ─── LOOT SPAWNER ────────────────────────────────────────────────
function spawnLoots(world, count=80) {
  const items = ['pistol','shotgun','ar','sniper',
                 'pistol_ammo','pistol_ammo','shells','shells','rifle','rifle',
                 'armor','armor','heal','heal','heal'];
  const loots = [];
  let tries = 0;
  while(loots.length < count && tries < 5000) {
    tries++;
    const tx = rndi(2, MAP_W-2);
    const ty = rndi(2, MAP_H-5);
    if(!world.isSolid(tx,ty)) {
      // Find ground below
      let ground = ty;
      while(ground < MAP_H && !world.isSolid(tx,ground)) ground++;
      if(ground<MAP_H && !world.isLava(tx,ground)) {
        const kind = items[rndi(0,items.length)];
        loots.push(new Loot(tx*TILE + TILE/2, ground*TILE - 12, kind));
      }
    }
  }
  return loots;
}

function spawnAnimals(world, count=20) {
  const types = Object.keys(ANIMAL_DEFS);
  const animals = [];
  let tries=0;
  while(animals.length < count && tries<3000) {
    tries++;
    const tx = rndi(4, MAP_W-4);
    const ty = rndi(2, MAP_H-5);
    if(!world.isSolid(tx,ty)) {
      let ground=ty;
      while(ground<MAP_H&&!world.isSolid(tx,ground)) ground++;
      if(ground<MAP_H&&!world.isLava(tx,ground)) {
        const type=types[rndi(0,types.length)];
        const a=new Animal(tx*TILE, ground*TILE-ANIMAL_DEFS[type].h, type);
        animals.push(a);
      }
    }
  }
  return animals;
}

function spawnBots(world) {
  const bots=[];
  let tries=0;
  while(bots.length<NUM_BOTS && tries<2000) {
    tries++;
    const tx=rndi(4,MAP_W-4);
    const ty=rndi(2,MAP_H-5);
    if(!world.isSolid(tx,ty)) {
      let ground=ty;
      while(ground<MAP_H&&!world.isSolid(tx,ground)) ground++;
      if(ground<MAP_H&&!world.isLava(tx,ground)) {
        bots.push(new Bot(tx*TILE, ground*TILE-28, bots.length+1));
      }
    }
  }
  return bots;
}

function spawnPlayer(world) {
  let tries=0;
  while(tries<2000) {
    tries++;
    const tx=rndi(4,MAP_W-4);
    const ty=rndi(2,MAP_H-5);
    if(!world.isSolid(tx,ty)) {
      let ground=ty;
      while(ground<MAP_H&&!world.isSolid(tx,ground)) ground++;
      if(ground<MAP_H&&!world.isLava(tx,ground)) {
        return new Player(tx*TILE, ground*TILE-28, 'YOU', true);
      }
    }
  }
  return new Player(MAP_W*TILE/2, 100, 'YOU', true);
}

// ─── GAME MANAGER ─────────────────────────────────────────────────
class GameManager {
  constructor() {
    this.canvas  = document.getElementById('gameCanvas');
    this.ctx     = this.canvas.getContext('2d');
    this.resize();
    window.addEventListener('resize', ()=>this.resize());

    this.snd     = new SoundManager();
    this.input   = new InputManager(this.canvas);
    this.running = false;
    this.frame   = 0;
    this._lastTime=0;

    // Init game state
    this.reset();

    // UI bindings
    document.getElementById('btn-start').addEventListener('click',()=>this.start());
    document.getElementById('btn-howto').addEventListener('click',()=>{
      document.getElementById('howto').classList.toggle('hidden');
    });
    document.getElementById('btn-restart').addEventListener('click',()=>this.restart());
    document.getElementById('btn-restart2').addEventListener('click',()=>this.restart());

    // Weapon slot keys
    document.addEventListener('keydown', e=>{
      if(!this.running) return;
      const slot={'Digit1':0,'Digit2':1,'Digit3':2,'Digit4':3,'Digit5':4}[e.code];
      if(slot!==undefined) this.player.selectSlot(slot);
      if(e.code==='KeyR') {
        if(this.player.weapon) this.player.weapon.startReload(Date.now(), this.snd);
      }
    });
  }

  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
    if(this.camera) {
      this.camera.vw = this.canvas.width;
      this.camera.vh = this.canvas.height;
    }
  }

  reset() {
    this.world      = new World();
    this.camera     = new Camera(window.innerWidth, window.innerHeight);
    this.player     = spawnPlayer(this.world);
    this.bots       = spawnBots(this.world);
    this.animals    = spawnAnimals(this.world, 18);
    this.loots      = spawnLoots(this.world, 90);
    this.projectiles= [];
    this.particles  = [];
    this.zone       = new SafeZone();
    this.hud        = new HUD();
    this.minimap    = new Minimap(document.getElementById('minimap'), this.world, 120);
    this.gameOver   = false;
    this.won        = false;
    this.totalPlayers = 1 + this.bots.length;
    this.frame      = 0;

    // Background scroll (ash storm visual)
    this.ashParticles = Array.from({length:60}, ()=>({
      x:rnd(0,MAP_W*TILE), y:rnd(0,MAP_H*TILE),
      dx:rnd(0.5,1.5), dy:rnd(0.2,0.8),
      size:rnd(1,3), alpha:rnd(0.1,0.4)
    }));
  }

  start() {
    this.snd.resume();
    document.getElementById('title-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    this.running=true;
    requestAnimationFrame(t=>this.loop(t));
  }

  restart() {
    document.getElementById('gameover-screen').classList.remove('active');
    document.getElementById('win-screen').classList.remove('active');
    this.reset();
    this.running=true;
  }

  loop(timestamp) {
    if(!this.running) return;
    // ~60fps cap
    const dt = Math.min(timestamp - this._lastTime, 50);
    this._lastTime = timestamp;
    this.frame++;

    this.update();
    this.render();
    this.input.flush();

    requestAnimationFrame(t=>this.loop(t));
  }

  update() {
    if(this.gameOver||this.won) return;
    const now = Date.now();

    // ── PLAYER INPUT ──
    const p = this.player;
    if(!p.dead) {
      const spd = 3.2;
      const left  = this.input.key('ArrowLeft')||this.input.key('KeyA');
      const right = this.input.key('ArrowRight')||this.input.key('KeyD');
      const jump  = this.input.key('ArrowUp')||this.input.key('KeyW')||this.input.key('Space');

      if(left)  { p.vx=-spd; p.facing=-1; }
      if(right) { p.vx=spd;  p.facing=1; }
      if(jump && p.onGround) { p.jump(); }

      // Shoot
      if(this.input.mouse.down || this.input.key('Space')) {
        this.input.update(this.camera);
        const attacks = p.fireWeapon(this.input.mouse.x, this.input.mouse.y, this.snd);
        for(const a of attacks) {
          if(a.isMelee) {
            // Melee: check all enemies in range
            const allEnemies = [...this.bots, ...this.animals];
            for(const e of allEnemies) {
              if(!e.alive) continue;
              if(dist(p,e)<a.range+p.w+e.w) {
                e.takeDamage(a.dmg, p);
                spawnBlood(this.particles, e.cx, e.cy);
                this.snd.hit();
                this.camera.addShake(5);
                if(!e.alive && e.isAnimal) {
                  this.hud.addKill(`YOU killed ${e.name}`);
                  this._dropLootFromAnimal(e);
                }
                if(!e.alive && !e.isAnimal) {
                  this.hud.addKill(`YOU eliminated ${e.name}`);
                  p.kills++;
                }
              }
            }
          } else {
            this.projectiles.push(a);
          }
        }
      }

      // Pickup
      if(this.input.key('KeyE')) {
        const nearby = this._nearestLoot(p, 50);
        if(nearby) this._pickupLoot(p, nearby);
      }

      // Facing from mouse (always update)
      this.input.update(this.camera);
      if(this.input.mouse.x > p.cx) p.facing=1; else p.facing=-1;

      p.update(this.world);

      // Zone damage
      if(!this.zone.isInside(p.cx, p.cy)) p.takeDamage(ZONE_DMG*0.5);

      if(p.dead) {
        const rank = 1 + this.bots.filter(b=>!b.dead).length;
        this.hud.showGameOver(rank, this.totalPlayers, p.kills);
        this.gameOver=true;
        this.snd.die();
      }
    }

    // ── BOTS ──
    const allPlayers = [p, ...this.bots];
    for(const bot of this.bots) {
      if(bot.dead) continue;
      bot.updateAI(this.world, allPlayers, this.loots, this.projectiles, this.snd, this.camera, this.particles);
      bot.update(this.world);

      // Bot loot pickup
      const nearby = this._nearestLoot(bot, 40);
      if(nearby) this._pickupLoot(bot, nearby);

      // Bot zone damage
      if(!this.zone.isInside(bot.cx, bot.cy)) bot.takeDamage(ZONE_DMG*0.3);

      if(bot.dead) {
        this.hud.addKill(`${bot.name} eliminated`);
        this.snd.die();
        // Drop some loot
        this.loots.push(new Loot(bot.cx, bot.cy, 'heal'));
      }
    }

    // ── ANIMALS ──
    for(const a of this.animals) {
      if(!a.alive) continue;
      a.update(this.world, allPlayers, this.projectiles, this.snd);
    }

    // ── PROJECTILES ──
    for(const proj of this.projectiles) {
      if(!proj.alive) continue;
      proj.update(this.world);
      // Check hits vs players
      for(const pl of allPlayers) {
        if(pl.dead||proj.owner===pl) continue;
        if(proj.x>pl.x&&proj.x<pl.x+pl.w&&proj.y>pl.y&&proj.y<pl.y+pl.h) {
          const headshot = proj.y < pl.y+8;
          const dmg = headshot ? proj.dmg*1.8 : proj.dmg;
          pl.takeDamage(dmg, proj.owner);
          spawnBlood(this.particles, proj.x, proj.y);
          proj.alive=false;
          this.camera.addShake(headshot?8:4);
          this.snd.hit();
          if(!pl.alive) {
            const killerName = proj.owner.isHuman?'YOU':proj.owner.name;
            const victim = pl.isHuman?'YOU':pl.name;
            this.hud.addKill(`${killerName} ${headshot?'⭐HEADSHOT':'killed'} ${victim}`);
          }
        }
      }
      // Check hits vs animals
      for(const a of this.animals) {
        if(!a.alive) continue;
        if(proj.x>a.x&&proj.x<a.x+a.w&&proj.y>a.y&&proj.y<a.y+a.h) {
          a.takeDamage(proj.dmg, proj.owner);
          spawnBlood(this.particles, proj.x, proj.y, 4);
          proj.alive=false;
          if(!a.alive) {
            this.hud.addKill(`${proj.owner.isHuman?'YOU':proj.owner.name} killed ${a.name}`);
            this._dropLootFromAnimal(a);
            if(proj.owner.isHuman) p.kills++;
          }
        }
      }
    }

    // ── PARTICLES ──
    for(const part of this.particles) part.update();

    // ── ZONE ──
    this.zone.update();

    // ── ASH STORM PARTICLES ──
    for(const ash of this.ashParticles) {
      ash.x += ash.dx; ash.y += ash.dy;
      if(ash.x>MAP_W*TILE) ash.x=0;
      if(ash.y>MAP_H*TILE) ash.y=0;
    }

    // ── CAMERA ──
    if(!p.dead) this.camera.follow(p);
    this.camera.update();

    // ── WIN CHECK ──
    const aliveCount = allPlayers.filter(pl=>!pl.dead).length;
    if(!this.won && aliveCount<=1 && !p.dead) {
      this.won=true;
      this.hud.showWin(p.kills);
    }

    // ── CLEAN ARRAYS ──
    this.projectiles = this.projectiles.filter(pr=>pr.alive);
    this.particles   = this.particles.filter(pa=>pa.alive);
    this.loots       = this.loots.filter(l=>l.alive);
    this.animals     = this.animals.filter(a=>a.alive);

    // ── HUD ──
    const nearLoot = this._nearestLoot(p, 50);
    const alive    = allPlayers.filter(pl=>!pl.dead).length;
    if(!p.dead) this.hud.update(p, this.zone, alive, nearLoot);
    this.minimap.draw(allPlayers, this.animals, this.zone);

    this.frame++;
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0,0,this.canvas.width,this.canvas.height);

    // Sky gradient (post-apocalyptic orange/red)
    const sky = ctx.createLinearGradient(0,0,0,this.canvas.height);
    sky.addColorStop(0,'#1a0a00');
    sky.addColorStop(0.5,'#3a1500');
    sky.addColorStop(1,'#0a0806');
    ctx.fillStyle=sky;
    ctx.fillRect(0,0,this.canvas.width,this.canvas.height);

    // Ash particles (screen space, behind world)
    ctx.save();
    for(const ash of this.ashParticles) {
      const s=this.camera.toScreen(ash.x,ash.y);
      if(s.x<0||s.x>this.canvas.width||s.y<0||s.y>this.canvas.height) continue;
      ctx.fillStyle=`rgba(180,160,140,${ash.alpha})`;
      ctx.fillRect(s.x,s.y,ash.size,ash.size);
    }
    ctx.restore();

    // World tiles
    this.world.draw(ctx, this.camera);

    // Safe zone overlay
    this.zone.draw(ctx, this.camera);

    // Loots
    for(const l of this.loots) { l.update(); l.draw(ctx,this.camera); }

    // Animals
    for(const a of this.animals) a.draw(ctx,this.camera);

    // Bots
    for(const b of this.bots) b.draw(ctx,this.camera);

    // Player
    this.player.draw(ctx, this.camera);

    // Projectiles
    for(const pr of this.projectiles) pr.draw(ctx,this.camera);

    // Particles
    for(const pa of this.particles) pa.draw(ctx,this.camera);

    // Lava glow (screen-level orange at bottom of screen if near lava)
    // Simple: scan bottom row of screen tiles
    const bottomY = Math.floor((this.camera.y+this.camera.vh)/TILE);
    let lavaCount=0;
    for(let tx=Math.floor(this.camera.x/TILE); tx<Math.floor((this.camera.x+this.camera.vw)/TILE); tx++) {
      if(this.world.isLava(tx,bottomY)) lavaCount++;
    }
    if(lavaCount>2) {
      const glow=ctx.createLinearGradient(0,this.canvas.height-60,0,this.canvas.height);
      glow.addColorStop(0,'transparent');
      glow.addColorStop(1,`rgba(255,80,0,${Math.min(0.3,lavaCount*0.02)})`);
      ctx.fillStyle=glow;
      ctx.fillRect(0,this.canvas.height-60,this.canvas.width,60);
    }
  }

  _nearestLoot(entity, maxDist) {
    let best=null, bestD=maxDist;
    for(const l of this.loots) {
      if(!l.alive) continue;
      const d=dist(entity,l);
      if(d<bestD){bestD=d;best=l;}
    }
    return best;
  }

  _pickupLoot(entity, loot) {
    if(!loot.alive) return;
    loot.alive=false;
    this.snd.pickup();
    const k=loot.kind;

    if(['pistol','shotgun','ar','sniper','knife'].includes(k)) {
      entity.addWeapon(k);
    } else if(k==='armor') {
      entity.armor=Math.min(entity.maxArmor, entity.armor+50);
    } else if(k==='heal') {
      entity.heal(40);
    } else if(k==='pistol_ammo') {
      const w=entity.inventory.find(w=>w&&w.ammoType==='pistol');
      if(w) w.addAmmo(24); else {
        // Store as generic
        entity.inventory.find(w=>w&&w.ammoType==='pistol')?.addAmmo(24);
      }
    } else if(k==='shells') {
      entity.inventory.find(w=>w&&w.ammoType==='shells')?.addAmmo(12);
    } else if(k==='rifle') {
      entity.inventory.find(w=>w&&(w.ammoType==='rifle'))?.addAmmo(30);
    }
  }

  _dropLootFromAnimal(animal) {
    if(Math.random()<animal.dropChance) {
      this.loots.push(new Loot(animal.cx, animal.cy, animal.lootDrop));
    }
  }
}

// ─── ENTRY POINT ────────────────────────────────────────────────
// Start when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window._game = new GameManager();
  // Keep title screen shown until player clicks start
});
