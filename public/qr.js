// QR Code (mode octet, correction M) — génération locale, sans internet.
(function (global) {
  const EXP = new Array(512);
  const LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  function gfMul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGenerator(ec) {
    let poly = [1];
    for (let i = 0; i < ec; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ec) {
    const gen = rsGenerator(ec);
    const res = data.slice();
    for (let i = 0; i < ec; i++) res.push(0);
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (!coef) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
    }
    return res.slice(data.length);
  }

  // data codewords, error blocks: [dataPerBlock, ecPerBlock, blockCount] groups
  const VERSIONS = [
    null,
    { size: 21, groups: [[16, 10, 1]], align: [] },
    { size: 25, groups: [[28, 16, 1]], align: [18] },
    { size: 29, groups: [[44, 26, 1]], align: [22] },
    { size: 33, groups: [[32, 18, 2]], align: [26] },
    { size: 37, groups: [[43, 24, 2]], align: [30] },
    { size: 41, groups: [[27, 16, 4]], align: [34] },
    { size: 45, groups: [[31, 18, 4]], align: [22, 38] },
    { size: 49, groups: [[38, 22, 2], [39, 22, 2]], align: [24, 42] },
    { size: 53, groups: [[36, 20, 3], [37, 20, 2]], align: [26, 46] },
    { size: 57, groups: [[43, 24, 4], [44, 24, 1]], align: [28, 50] },
  ];

  function capacity(v) {
    return VERSIONS[v].groups.reduce((s, g) => s + g[0] * g[2], 0);
  }

  function pickVersion(byteLen) {
    const countBits = (v) => (v <= 9 ? 8 : 16);
    for (let v = 1; v <= 10; v++) {
      const bits = 4 + countBits(v) + byteLen * 8 + 4;
      if (Math.ceil(bits / 8) <= capacity(v)) return v;
    }
    return 10;
  }

  function bitsToBytes(bits) {
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
      out.push(b);
    }
    return out;
  }

  function encodeData(text, version) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 255);
    const cap = capacity(version);
    const countBits = version <= 9 ? 8 : 16;
    const bits = [];
    function push(val, n) {
      for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    }
    push(0b0100, 4);
    push(bytes.length, countBits);
    bytes.forEach((b) => push(b, 8));
    const remaining = cap * 8 - bits.length;
    push(0, Math.min(4, Math.max(0, remaining)));
    while (bits.length % 8) bits.push(0);
    const data = bitsToBytes(bits);
    const pads = [0xec, 0x11];
    let p = 0;
    while (data.length < cap) data.push(pads[p++ % 2]);
    return data.slice(0, cap);
  }

  function makeBlocks(data, version) {
    const groups = VERSIONS[version].groups;
    const blocks = [];
    let offset = 0;
    groups.forEach(([dc, ec, count]) => {
      for (let i = 0; i < count; i++) {
        const chunk = data.slice(offset, offset + dc);
        offset += dc;
        blocks.push({ data: chunk, ec: rsEncode(chunk, ec) });
      }
    });
    const interleaved = [];
    const maxD = Math.max(...blocks.map((b) => b.data.length));
    const maxE = Math.max(...blocks.map((b) => b.ec.length));
    for (let i = 0; i < maxD; i++) {
      blocks.forEach((b) => { if (i < b.data.length) interleaved.push(b.data[i]); });
    }
    for (let i = 0; i < maxE; i++) {
      blocks.forEach((b) => { if (i < b.ec.length) interleaved.push(b.ec[i]); });
    }
    return interleaved;
  }

  function setFinder(mod, x, y) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= mod.length || yy >= mod.length) continue;
        const on = dx === -1 || dx === 7 || dy === -1 || dy === 7
          ? false
          : (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        mod[yy][xx] = on ? 1 : 0;
      }
    }
  }

  function setAlign(mod, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        mod[cy + dy][cx + dx] = on ? 1 : 0;
      }
    }
  }

  function isReserved(size, x, y, align) {
    if (y < 9 && x < 9) return true;
    if (y < 9 && x >= size - 8) return true;
    if (y >= size - 8 && x < 9) return true;
    if (y === 6 || x === 6) return true;
    const pos = [6].concat(align);
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const ax = pos[i];
        const ay = pos[j];
        if ((ax < 10 && ay < 10) || (ax < 10 && ay > size - 11) || (ax > size - 11 && ay < 10)) continue;
        if (Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2) return true;
      }
    }
    if (x === 8 && y >= size - 8) return true;
    if (y === 8 && x >= size - 8) return true;
    return false;
  }

  function maskFn(id, x, y) {
    switch (id) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function formatBits(mask) {
    const ec = 0b00; // M
    let data = (ec << 3) | mask;
    let bits = data << 10;
    const gen = 0b10100110111;
    for (let i = 14; i >= 10; i--) {
      if ((bits >> i) & 1) bits ^= gen << (i - 10);
    }
    return (data << 10 | bits) ^ 0b101010000010010;
  }

  function placeFormat(mod, size, mask) {
    const bits = formatBits(mask);
    const coordsA = [];
    for (let i = 0; i < 6; i++) coordsA.push([8, i]);
    coordsA.push([8, 7], [8, 8], [7, 8]);
    for (let i = 5; i >= 0; i--) coordsA.push([i, 8]);
    const coordsB = [];
    for (let i = 0; i < 8; i++) coordsB.push([size - 1 - i, 8]);
    for (let i = 0; i < 7; i++) coordsB.push([8, size - 7 + i]);
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> (14 - i)) & 1;
      mod[coordsA[i][1]][coordsA[i][0]] = bit;
      mod[coordsB[i][1]][coordsB[i][0]] = bit;
    }
    mod[size - 8][8] = 1;
  }

  function penalty(mod) {
    const n = mod.length;
    let s = 0;
    for (let y = 0; y < n; y++) {
      let run = 1;
      for (let x = 1; x < n; x++) {
        if (mod[y][x] === mod[y][x - 1]) run++;
        else { if (run >= 5) s += run - 2; run = 1; }
      }
      if (run >= 5) s += run - 2;
    }
    for (let x = 0; x < n; x++) {
      let run = 1;
      for (let y = 1; y < n; y++) {
        if (mod[y][x] === mod[y - 1][x]) run++;
        else { if (run >= 5) s += run - 2; run = 1; }
      }
      if (run >= 5) s += run - 2;
    }
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const v = mod[y][x];
        if (v === mod[y][x + 1] && v === mod[y + 1][x] && v === mod[y + 1][x + 1]) s += 3;
      }
    }
    let dark = 0;
    mod.forEach((row) => row.forEach((c) => { if (c) dark++; }));
    s += Math.abs(Math.floor((dark * 100) / (n * n) / 5) * 10);
    return s;
  }

  function buildMatrix(text) {
    const version = pickVersion(text.length);
    const spec = VERSIONS[version];
    const size = spec.size;
    const data = makeBlocks(encodeData(text, version), version);
    const bits = [];
    data.forEach((b) => {
      for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    });

    function template() {
      const mod = Array.from({ length: size }, () => new Array(size).fill(null));
      setFinder(mod, 0, 0);
      setFinder(mod, size - 7, 0);
      setFinder(mod, 0, size - 7);
      for (let i = 8; i < size - 8; i++) {
        mod[6][i] = i % 2 === 0 ? 1 : 0;
        mod[i][6] = i % 2 === 0 ? 1 : 0;
      }
      const pos = [6].concat(spec.align);
      for (let i = 0; i < pos.length; i++) {
        for (let j = 0; j < pos.length; j++) {
          const ax = pos[i];
          const ay = pos[j];
          if ((ax < 10 && ay < 10) || (ax < 10 && ay > size - 11) || (ax > size - 11 && ay < 10)) continue;
          setAlign(mod, ax, ay);
        }
      }
      return mod;
    }

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const mod = template();
      let bi = 0;
      let dir = -1;
      for (let x = size - 1; x > 0; x -= 2) {
        if (x === 6) x--;
        for (let i = 0; i < size; i++) {
          const y = dir < 0 ? size - 1 - i : i;
          for (let dx = 0; dx < 2; dx++) {
            const xx = x - dx;
            if (mod[y][xx] !== null) continue;
            const bit = bits[bi++] || 0;
            mod[y][xx] = bit ^ (maskFn(mask, xx, y) ? 1 : 0);
          }
        }
        dir = -dir;
      }
      placeFormat(mod, size, mask);
      const score = penalty(mod);
      if (score < bestScore) {
        bestScore = score;
        best = mod;
      }
    }
    return best;
  }

  function makeQrDataUrl(text, scale, quietModules) {
    const mod = buildMatrix(String(text || ''));
    const quiet = Math.max(4, Number(quietModules) || 4);
    const s = Math.max(4, Number(scale) || 8);
    const n = mod.length;
    const dim = (n + quiet * 2) * s;
    const canvas = document.createElement('canvas');
    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (mod[y][x]) ctx.fillRect((x + quiet) * s, (y + quiet) * s, s, s);
      }
    }
    return canvas.toDataURL('image/png');
  }

  function paintImg(img, text) {
    img.alt = 'QR code';
    img.className = 'pair-qr';
    try {
      img.src = makeQrDataUrl(text, 10, 6);
    } catch (e) {
      img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&ecc=M&margin=8&data='
        + encodeURIComponent(text);
    }
  }

  function renderQr(el, text) {
    if (!el || !text) return;
    try {
      if (el.tagName === 'IMG') {
        paintImg(el, text);
        return;
      }
      el.innerHTML = '';
      const img = document.createElement('img');
      paintImg(img, text);
      el.appendChild(img);
    } catch (e) {
      el.innerHTML = '';
    }
  }

  global.renderQr = renderQr;
  global.makeQrDataUrl = makeQrDataUrl;
  global.isQuickTunnelOrigin = function (text) {
    try {
      const u = new URL(String(text || ''));
      const h = u.hostname || '';
      return h.endsWith('.trycloudflare.com') && h !== 'api.trycloudflare.com';
    } catch (e) {
      return false;
    }
  };
  global.isScannableQrUrl = function (text) {
    try {
      const u = new URL(String(text || ''));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      const h = u.hostname;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return false;
      if (h === 'api.trycloudflare.com') return false;
      return true;
    } catch (e) {
      return false;
    }
  };
})(window);
