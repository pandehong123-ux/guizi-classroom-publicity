import { inflateSync } from 'node:zlib';

// Keep offsets/newlines stable while removing Markdown code examples.
export function outsideFences(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && m) { fence = { char: m[1][0], length: m[1].length }; return ''; }
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null;
      return '';
    }
    return line;
  }).join('\n');
}
export function articleText(text) {
  return outsideFences(text).replace(/<!--[^]*?-->/g, '').replace(/(`+)([^]*?)\1/g, '');
}
const unescape = text => text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, '$1');
export function markdownImages(text) {
  const result = [];
  text = articleText(text);
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '!' || text[start + 1] !== '[' || text[start - 1] === '\\') continue;
    let end = start + 2, depth = 1;
    for (; end < text.length; end++) {
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '[') depth++;
      if (text[end] === ']' && --depth === 0) break;
    }
    if (end >= text.length || text[end + 1] !== '(') continue;
    const alt = unescape(text.slice(start + 2, end));
    let cursor = end + 2, destination = '', valid = true;
    if (text[cursor] === '<') {
      cursor++;
      while (cursor < text.length && text[cursor] !== '>') {
        if (text[cursor] === '\n' || text[cursor] === '<') { valid = false; break; }
        if (text[cursor] === '\\' && cursor + 1 < text.length) destination += text[cursor++];
        destination += text[cursor++];
      }
      if (text[cursor] !== '>') valid = false;
      cursor++;
    } else {
      depth = 0;
      while (cursor < text.length) {
        const char = text[cursor];
        if (char === '\\' && cursor + 1 < text.length) { destination += char + text[cursor + 1]; cursor += 2; continue; }
        if (/\s/.test(char)) break;
        if (char === '(') depth++;
        if (char === ')') { if (!depth) break; depth--; }
        destination += char; cursor++;
      }
      if (depth) valid = false;
    }
    while (/\s/.test(text[cursor] || '')) cursor++;
    // Support an optional quoted Markdown image title.
    if (['"', "'"].includes(text[cursor])) {
      const quote = text[cursor++];
      while (cursor < text.length && text[cursor] !== quote) { if (text[cursor] === '\\') cursor++; cursor++; }
      if (text[cursor++] !== quote) valid = false;
      while (/\s/.test(text[cursor] || '')) cursor++;
    }
    if (!valid || text[cursor] !== ')' || !destination) continue;
    try { destination = decodeURIComponent(unescape(destination)); } catch { continue; }
    result.push({ alt, file: destination, index: start });
    start = cursor;
  }
  return result;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  return c >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff; for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function validatePng(bytes) {
  const invalid = reason => { throw new Error(`不是有效 PNG：${reason}`); };
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid('签名或长度');
  let offset = 8, header, ended = false, palette = false, sawData = false, dataEnded = false;
  const data = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('数据块截断');
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), end = offset + 12 + length;
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type)) invalid('数据块长度或类型');
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid('校验和');
    const content = bytes.subarray(offset + 8, end - 4);
    if (!header && type !== 'IHDR') invalid('缺少首部');
    if (type === 'IHDR') {
      if (header || length !== 13) invalid('首部重复或长度');
      header = { width: content.readUInt32BE(0), height: content.readUInt32BE(4), bits: content[8], color: content[9], interlace: content[12] };
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!header.width || !header.height || !depths[header.color]?.includes(header.bits) || content[10] || content[11] || header.interlace > 1) invalid('不合法首部');
    } else if (type === 'PLTE') {
      if (palette || sawData || !length || length % 3 || length > 768) invalid('调色板');
      palette = length / 3;
      if (header.color === 3 && palette > 2 ** header.bits) invalid('调色板项数超出位深');
    } else if (type === 'IDAT') {
      if (dataEnded) invalid('数据块不连续');
      sawData = true; data.push(content);
    } else if (type === 'IEND') {
      if (length || !sawData || end !== bytes.length) invalid('结束块');
      ended = true; offset = end; break;
    } else {
      if (sawData) dataEnded = true;
      if (type[0] === type[0].toUpperCase()) invalid(`未知关键块 ${type}`);
    }
    offset = end;
  }
  if (!ended || header.color === 3 && !palette) invalid('缺少结束块或调色板');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.color];
  const passes = header.interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const layouts = passes.map(([x,y,dx,dy]) => {
    const width = Math.max(0, Math.ceil((header.width-x)/dx)), height = Math.max(0, Math.ceil((header.height-y)/dy));
    return { width, stride: 1 + Math.ceil(width * channels * header.bits / 8), rows: width ? height : 0 };
  });
  const expected = layouts.reduce((sum, p) => sum + p.stride * p.rows, 0);
  if (expected > 512 * 1024 * 1024) invalid('图像超出检查容量');
  let raster; try { raster = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }); } catch { invalid('压缩数据损坏'); }
  if (raster.length !== expected) invalid('像素数据截断或尺寸不符');
  let row = 0;
  for (const layout of layouts) {
    let previous = Buffer.alloc(layout.stride - 1);
    for (let i = 0; i < layout.rows; i++) {
      const filter = raster[row];
      if (filter > 4) invalid('扫描行过滤器');
      if (header.color === 3) {
        const restored = Buffer.alloc(layout.stride - 1);
        for (let byte = 0; byte < restored.length; byte++) {
          const left = byte ? restored[byte - 1] : 0, up = previous[byte], corner = byte ? previous[byte - 1] : 0;
          const predicted = left + up - corner;
          const pa = Math.abs(predicted - left), pb = Math.abs(predicted - up), pc = Math.abs(predicted - corner);
          const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner) : 0;
          restored[byte] = (raster[row + 1 + byte] + predictor) & 255;
        }
        for (let pixel = 0; pixel < layout.width; pixel++) {
          const bit = pixel * header.bits, shift = 8 - header.bits - bit % 8;
          const index = restored[Math.floor(bit / 8)] >> shift & ((1 << header.bits) - 1);
          if (index >= palette) invalid('像素引用不存在的调色板颜色');
        }
        previous = restored;
      }
      row += layout.stride;
    }
  }
  return header;
}
