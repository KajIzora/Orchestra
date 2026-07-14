/*
 * <pixel-bot> — tiny 8-bit provider mascots for the Orchestra live feed mockups.
 *
 * Usage: <pixel-bot provider="claude" state="working" scale="3"></pixel-bot>
 *   provider: claude | codex | cursor | gemini | chatgpt | terminal | grok
 *   state:    working | blocked | done | idle      (blocked = needs input)
 *   scale:    px per sprite pixel (default 4)
 *   browser:  present → draws faint browser-window dots (browser-chat surface)
 *
 * Original pixel characters keyed to each provider's palette (Orchestra's --plat-* tints).
 * Canvas is 28×20 logical pixels; everything is drawn as filled rects (crisp at any scale).
 */
(function () {
  'use strict';
  if (window.customElements && customElements.get('pixel-bot')) return;

  var GRID_W = 28, GRID_H = 20;
  var BOT_X = 6;           // sprite column offset
  var TICK_MS = 280;

  // ---- sprite bodies (13 wide). chars: B body · S shade · W white · A accent · D dark · G green · e eye ----
  var BODIES = {
    claude: {
      offY: 2, armless: true, face: 'B',
      rows: [
        '......B......',
        '.....BBB.....',
        '..B..BBB..B..',
        '.BB.BBBBB.BB.',
        '..BBBBBBBBB..',
        '...BBBBBBB...',
        '.BBBBeBeBBBB.',
        '...BBBSBBB...',
        '..BBBBBBBBB..',
        '.BB.BBBBB.BB.',
        '..B..BBB..B..',
        '.....BBB.....',
        '......B......'
      ],
      pal: { B: '#d97757', S: '#8f3f23', e: '#4a2415' }
    },
    codex: {
      offY: 3, arms: { lx: 2, rx: 10, y: 8 }, face: 'W',
      rows: [
        '......S......',
        '....BBBBB....',
        '..BBBBBBBBB..',
        '.BBWWWWWWWBB.',
        '.BBWeWWWeWBB.',
        '.BBWWWWWWWBB.',
        '..BBBBBBBBB..',
        '....BBBBB....',
        '...BBBBBBB...',
        '...BBSSSBB...',
        '...BBBBBBB...',
        '....B...B....'
      ],
      pal: { B: '#10a37f', S: '#0b6e56', W: '#eafaf4', e: '#0b3f31' }
    },
    cursor: {
      offY: 3, arms: { lx: 2, rx: 10, y: 8 }, face: 'S',
      rows: [
        '...W.........',
        '...WW........',
        '...WWW.......',
        '..BBBBBBBBB..',
        '..BSSSSSSSB..',
        '..BSSeSeSSB..',
        '..BSSSSSSSB..',
        '..BBBBBBBBB..',
        '....BBBBB....',
        '...BBBBBBB...',
        '...BBBBBBB...',
        '....B...B....'
      ],
      pal: { B: '#26241f', S: '#3d3a33', W: '#26241f', e: '#ffffff' }
    },
    gemini: {
      offY: 2, armless: true, face: 'A',
      rows: [
        '......B......',
        '......B......',
        '.....BAB.....',
        '.....BAB.....',
        '....BAAAB....',
        '.BBBAAAAABBB.',
        'BAAAAeAeAAAAB',
        '.BBBAAAAABBB.',
        '....BAAAB....',
        '.....BAB.....',
        '.....BAB.....',
        '......B......',
        '......B......'
      ],
      pal: { B: '#8159c7', A: '#c9b6ee', e: '#3a2570' }
    },
    chatgpt: {
      offY: 3, arms: { lx: 1, rx: 11, y: 8 }, face: 'W',
      rows: [
        '...BBBBBBB...',
        '..BBBBBBBBB..',
        '.BBWWBBBWWBB.',
        '.BBWeBBBWeBB.',
        '..BBBBBBBBB..',
        '...BBBBBBB...',
        '....BB.......',
        '...BBBBBBB...',
        '..BBBBBBBBB..',
        '..BBSSSSSBB..',
        '..BBBBBBBBB..',
        '....B...B....'
      ],
      pal: { B: '#74aa9c', S: '#567f74', W: '#f2f8f6', e: '#2f4a42' }
    },
    terminal: {
      offY: 3, arms: { lx: 2, rx: 10, y: 8 }, face: 'D', crt: true,
      rows: [
        '.BBBBBBBBBBB.',
        '.BDDDDDDDDDB.',
        '.BDGDDDDDDDB.',
        '.BDDGDDDDDDB.',
        '.BDGDDDDDDDB.',
        '.BDDDDDDDDDB.',
        '.BBBBBBBBBBB.',
        '....BBBBB....',
        '...BBBBBBB...',
        '...BBSSSBB...',
        '...BBBBBBB...',
        '....B...B....'
      ],
      pal: { B: '#8b8680', S: '#6b675e', D: '#22211c', G: '#7cb342' }
    },
    grok: {
      // "Saucer" — hovers constantly; marquee rim lights; tractor-beams the keyboard while working
      offY: 5, armless: true, hover: true, face: 'W', lightsRow: 5, beam: true,
      rows: [
        '.....DDD.....',
        '....DWWWD....',
        '...DWeWeWD...',
        '..DWWWWWWWD..',
        '.BBBBBBBBBBB.',
        'BAAAAAAAAAAAB',
        '.BBBBBBBBBBB.',
        '..B.......B..'
      ],
      pal: { D: '#262b34', W: '#eef0f5', B: '#4d5566', A: '#39404e', e: '#262b34' }
    }
  };

  // pixel glyphs for the speech bubble (relative coords)
  var GLYPH_Q = [[1, 1], [2, 1], [3, 2], [2, 3], [2, 5]];                    // ?
  var GLYPH_CHECK = [[0, 3], [1, 4], [2, 3], [3, 2], [4, 1]];                // ✓
  var GLYPH_Z = [[0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2]];    // z (idle)

  function px(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * s, y * s, s, s);
  }

  var PixelBot = function () {
    return Reflect.construct(HTMLElement, [], PixelBot);
  };
  PixelBot.prototype = Object.create(HTMLElement.prototype);
  PixelBot.prototype.constructor = PixelBot;
  Object.setPrototypeOf(PixelBot, HTMLElement);

  PixelBot.observedAttributes = ['provider', 'state', 'scale', 'browser'];

  PixelBot.prototype.connectedCallback = function () {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._canvas.style.display = 'block';
      this.appendChild(this._canvas);
      this.style.display = 'inline-block';
      this.style.lineHeight = '0';
    }
    this._frame = 0;
    this._resize();
    var self = this;
    this._timer = setInterval(function () {
      self._frame += 1;
      self._draw();
    }, TICK_MS);
    this._draw();
  };

  PixelBot.prototype.disconnectedCallback = function () {
    clearInterval(this._timer);
  };

  PixelBot.prototype.attributeChangedCallback = function (name) {
    if (!this._canvas) return;
    if (name === 'scale') this._resize();
    this._draw();
  };

  PixelBot.prototype._resize = function () {
    var s = this._s();
    this._canvas.width = GRID_W * s;
    this._canvas.height = GRID_H * s;
    this._canvas.style.width = GRID_W * s + 'px';
    this._canvas.style.height = GRID_H * s + 'px';
  };

  PixelBot.prototype._s = function () {
    var v = parseFloat(this.getAttribute('scale'));
    return v > 0 ? v : 4;
  };

  PixelBot.prototype._draw = function () {
    var canvas = this._canvas;
    if (!canvas) return;
    var s = this._s();
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var provider = this.getAttribute('provider') || 'claude';
    var state = this.getAttribute('state') || 'working';
    if (state === 'waiting') state = 'idle';
    var def = BODIES[provider] || BODIES.claude;
    var f = this._frame;
    var working = state === 'working';
    var blocked = state === 'blocked';
    var done = state === 'done';
    var idle = state === 'idle';

    // ground shadow
    ctx.fillStyle = 'rgba(35,34,30,0.08)';
    ctx.fillRect(8 * s, 18 * s, 10 * s, s);

    // browser-chat hint: three window dots, top-left (attr may arrive as the string "false")
    var browserAttr = this.getAttribute('browser');
    if (browserAttr != null && browserAttr !== 'false') {
      px(ctx, 1, 0, s, '#cfc9bf');
      px(ctx, 3, 0, s, '#cfc9bf');
      px(ctx, 5, 0, s, '#cfc9bf');
    }

    // keyboard (only while working)
    if (working) {
      ctx.fillStyle = '#423f38';
      ctx.fillRect(8 * s, 16 * s, 10 * s, 2 * s);
      for (var kx = 9; kx <= 16; kx += 2) px(ctx, kx, 16, s, '#6b675e');
      var flash = 9 + ((f % 4) * 2);
      px(ctx, flash, 16, s, '#d79a2a');                    // flashing key
      px(ctx, flash + (f % 2 ? 1 : -1), 14, s, '#d79a2a'); // keystroke spark
    }

    // body (armless characters bounce while typing)
    var bounce = (def.hover || (working && def.armless)) ? (f % 2) : 0;
    var oy = def.offY + bounce;
    var eyesOpen = !(f % 8 === 7);
    for (var y = 0; y < def.rows.length; y++) {
      var row = def.rows[y];
      for (var x = 0; x < row.length; x++) {
        var c = row[x];
        if (c === '.') continue;
        var color;
        if (c === 'e') color = eyesOpen ? def.pal.e : def.pal[def.face];
        else color = def.pal[c];
        if (color) px(ctx, BOT_X + x, oy + y, s, color);
      }
    }

    // CRT screen life: blinking cursor + output lines while working
    if (def.crt) {
      if (f % 2 === 0) px(ctx, BOT_X + 6, oy + 3, s, def.pal.G);
      if (working) {
        var n = f % 5;
        for (var i = 0; i < n; i++) px(ctx, BOT_X + 6 + i, oy + 4 + (i % 2 === 0 ? 0 : -2), s, '#4d6e2b');
      }
    }

    // saucer life: marquee rim lights + tractor beam onto the keyboard (grok)
    if (def.lightsRow != null) {
      for (var li = 1; li <= 11; li++) {
        px(ctx, BOT_X + li, oy + def.lightsRow, s, (li + f) % 3 === 0 ? '#eef0f5' : '#39404e');
      }
    }
    if (def.beam && working) {
      for (var byy = 13; byy <= 15; byy++) {
        var half = byy - 11;
        for (var bxx = 12 - half; bxx <= 12 + half; bxx++) {
          if ((bxx + byy + f) % 2 === 0) px(ctx, bxx, byy, s, 'rgba(127,136,153,0.45)');
        }
      }
      px(ctx, 11 + (f % 3), 14, s, 'rgba(238,240,245,0.9)');
    }

    // arms
    if (def.arms) {
      var ay = def.offY + def.arms.y;
      var lx = BOT_X + def.arms.lx, rx = BOT_X + def.arms.rx;
      var B = def.pal.B, S = def.pal.S || def.pal.B;
      if (blocked) {
        // left arm down, right arm raised high
        px(ctx, lx, ay, s, B); px(ctx, lx, ay + 1, s, S);
        px(ctx, rx, ay, s, B); px(ctx, rx, ay - 1, s, B); px(ctx, rx, ay - 2, s, B); px(ctx, rx, ay - 3, s, S);
      } else if (working) {
        var lUp = f % 2 === 0;
        px(ctx, lx, ay, s, B); px(ctx, lx - 0, ay + (lUp ? 1 : 2), s, S);
        px(ctx, rx, ay, s, B); px(ctx, rx - 0, ay + (lUp ? 2 : 1), s, S);
      } else {
        px(ctx, lx, ay, s, B); px(ctx, lx, ay + 1, s, S);
        px(ctx, rx, ay, s, B); px(ctx, rx, ay + 1, s, S);
      }
    } else if (blocked) {
      // armless characters: a raised nub on the right edge
      px(ctx, BOT_X + 12, oy + 4, s, def.pal.B);
      px(ctx, BOT_X + 12, oy + 3, s, def.pal.B);
    }

    // speech bubble (top-right)
    var bubble = null;
    if (blocked) bubble = { border: '#e06a5a', glyph: GLYPH_Q, color: '#e06a5a', blink: true };
    else if (done) bubble = { border: '#2d9d78', glyph: GLYPH_CHECK, color: '#1d7a4c', blink: false };
    else if (idle) bubble = { border: '#cfc9bf', glyph: GLYPH_Z, color: '#9a948a', blink: true };
    if (bubble && (!bubble.blink || f % 4 < 3)) {
      var bx = 20, by = 0;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx * s, by * s, 7 * s, 7 * s);
      ctx.fillStyle = bubble.border;
      ctx.fillRect(bx * s, by * s, 7 * s, s);
      ctx.fillRect(bx * s, (by + 6) * s, 7 * s, s);
      ctx.fillRect(bx * s, by * s, s, 7 * s);
      ctx.fillRect((bx + 6) * s, by * s, s, 7 * s);
      px(ctx, bx - 1, by + 7, s, bubble.border); // tail toward the bot
      for (var g = 0; g < bubble.glyph.length; g++) {
        px(ctx, bx + 1 + bubble.glyph[g][0], by + 1 + bubble.glyph[g][1], s, bubble.color);
      }
    }
  };

  // Property accessors mirroring the attributes, so React (which may set DOM properties on
  // custom elements) and plain setAttribute both drive the same rendering path.
  ['provider', 'state', 'scale'].forEach(function (name) {
    Object.defineProperty(PixelBot.prototype, name, {
      get: function () { return this.getAttribute(name); },
      set: function (v) {
        if (v == null || v === false) this.removeAttribute(name);
        else this.setAttribute(name, String(v));
      }
    });
  });
  Object.defineProperty(PixelBot.prototype, 'browser', {
    get: function () { return this.hasAttribute('browser'); },
    set: function (v) {
      if (v && v !== 'false') this.setAttribute('browser', '');
      else this.removeAttribute('browser');
    }
  });

  customElements.define('pixel-bot', PixelBot);
  window.PIXEL_BOT_PROVIDERS = ['claude', 'codex', 'cursor', 'gemini', 'chatgpt', 'terminal', 'grok'];
})();
