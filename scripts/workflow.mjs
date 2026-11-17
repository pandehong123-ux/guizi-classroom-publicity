#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { outsideFences, articleText, markdownImages, validatePng } from './formats.mjs';

const [command, directory, ...args] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
function option(name, fallback) {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] ?? fail(`缺少 ${name} 的参数`);
}
function read(path) { return readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); }
function inside(root, path) { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)); }
function safePath(root, name) {
  const target = resolve(root, name);
  if (!inside(root, target)) fail(`路径超出任务目录：${name}`);
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  if (!inside(root, realpathSync(existing))) fail(`路径通过链接超出任务目录：${name}`);
  // An existing dangling symlink can evade existsSync; reject it explicitly.
  try { if (lstatSync(target).isSymbolicLink()) fail(`图片路径不能是符号链接：${name}`); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  return target;
}
function digest(root) {
  return createHash('sha256').update(readFileSync(resolve(root, '制作方案.md'))).update('\0')
    .update(readFileSync(resolve(root, '图片清单.json'))).digest('hex');
}
function manifest(root) {
  if (!existsSync(resolve(root, '制作方案.md'))) fail('缺少 制作方案.md');
  const data = JSON.parse(read(resolve(root, '图片清单.json')));
  if (!Number.isInteger(data.version) || data.version < 1) fail('清单 version 必须是正整数');
  if (!Array.isArray(data.sections) || !data.sections.length || !Array.isArray(data.images) || !data.images.length) fail('清单必须包含 sections 和 images');
  const sections = new Map();
  for (const s of data.sections) {
    if (!s.id || sections.has(s.id) || !['intro', 'gate', 'feature'].includes(s.kind) || !s.title) fail('小节编号、类型或标题无效/重复');
    sections.set(s.id, { ...s, count: 0 });
  }
  const ids = new Set(), files = new Set();
  for (const im of data.images) {
    if (typeof im.id !== 'string' || !/^\d{2,3}$/.test(im.id) || ids.has(im.id)) fail(`图片编号无效或重复：${im.id}`);
    if (typeof im.file !== 'string' || !/^images\/[^/\\<>:"|?*]+\.png$/.test(im.file) || im.file.includes('..') || files.has(im.file.toLowerCase())) fail(`图片文件路径无效或重复：${im.file}`);
    if (!sections.has(im.section) || !im.concept?.trim() || !im.source?.trim()) fail(`图片 ${im.id} 缺少对应小节、画面或依据`);
    safePath(root, im.file);
    ids.add(im.id); files.add(im.file.toLowerCase()); sections.get(im.section).count++;
  }
  for (const s of sections.values()) {
    if (s.kind === 'gate' && s.count !== 2) fail(`关卡 ${s.title} 必须恰好两图，实际 ${s.count}`);
    if (s.count < 1) fail(`小节 ${s.title} 没有配图`);
  }
  return data;
}
function approved(root) {
  const path = resolve(root, 'workflow-state.json');
  if (!existsSync(path)) fail('尚未记录用户对当前方案的确认');
  const state = JSON.parse(read(path));
  if (!['approved', 'producing', 'complete'].includes(state.status) || !state.confirmation?.trim() || state.planDigest !== digest(root)) fail('方案尚未确认，或方案/图片清单已变化，需重新确认');
  return state;
}
function compact(text) { return text.replace(/\s+/g, '').replace(/[*_`]/g, ''); }
function finalCheck(root, data) {
  approved(root);
  const article = articleText(read(resolve(root, '推广推文.md')));
  const prompts = outsideFences(read(resolve(root, '推文配图生图提示词.md')));
  if (/报名|开玩时间|集合地点|招募对象/.test(article)) fail('正文含报名或主办方信息');
  const images = markdownImages(article);
  if (images.length !== data.images.length) fail('正文图片数量与清单不一致');
  const markers = [...prompts.matchAll(/<!--\s*image:(\d{2,3})\s*-->/g)];
  if (markers.length !== data.images.length) fail('提示词独立图片块数量与清单不一致');
  for (let i = 0; i < data.images.length; i++) {
    const im = data.images[i], actual = images[i], marker = markers[i];
    const altId = actual.alt.match(/^图片(\d{2,3})(?!\d)/)?.[1];
    if (actual.file !== im.file || altId !== im.id) fail(`正文图片 ${im.id} 路径、编号或顺序不对应`);
    if (marker[1] !== im.id) fail(`提示词图片 ${im.id} 编号或顺序不对应`);
    const block = prompts.slice(marker.index + marker[0].length, markers[i + 1]?.index ?? prompts.length);
    const fileFields = [...block.matchAll(/^文件[：:]\s*(.+)$/gm)];
    if (fileFields.length !== 1 || fileFields[0][1].trim() !== im.file) fail(`提示词 ${im.id} 文件字段缺失、重复或不对应`);
    const quote = block.match(/^对应文案[：:]\s*(.+)$/m)?.[1];
    if (!quote || !compact(article).includes(compact(quote))) fail(`提示词 ${im.id} 对应文案不是正文原句`);
    const prompt = block.match(/^提示词[：:]\s*([\s\S]*?)(?=\n(?:约束|负面约束|##|<!--)[：:]?|$)/m)?.[1]?.trim();
    if (!prompt || prompt.length < 30) fail(`图片 ${im.id} 缺少完整独立提示词`);
    const picture = safePath(root, im.file);
    if (!existsSync(picture)) fail(`图片 ${im.id} 占位文件不存在`);
    const bytes = readFileSync(picture);
    try { validatePng(bytes); } catch (e) { fail(`图片 ${im.id} ${e.message}`); }
  }
}
try {
  if (!directory || !['check', 'approve', 'placeholders'].includes(command)) fail('用法：node workflow.mjs check|approve|placeholders <任务目录> [--phase plan|final] [--confirmation 用户原话]');
  const root = realpathSync(resolve(directory));
  const data = manifest(root);
  if (command === 'approve') {
    const confirmation = option('--confirmation', '')?.trim();
    if (!confirmation) fail('必须提供当前用户实际确认原话，不能自行生成');
    const state = { status: 'approved', version: data.version, planDigest: digest(root), confirmation, confirmedAt: new Date().toISOString() };
    safePath(root, 'workflow-state.json');
    writeFileSync(resolve(root, 'workflow-state.json'), JSON.stringify(state, null, 2) + '\n');
    console.log(`已记录方案 v${data.version} 的确认；此工具不替代对话中的用户确认。`);
  } else if (command === 'placeholders') {
    approved(root);
    const template = fileURLToPath(new URL('../assets/placeholder.png', import.meta.url));
    let created = 0;
    for (const im of data.images) {
      const target = safePath(root, im.file);
      if (!existsSync(target)) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(template, target); created++; }
    }
    console.log(`新增 ${created} 张示意占位 PNG；已存在的图片保持原文件。`);
  } else {
    const phase = option('--phase', 'plan');
    if (!['plan', 'final'].includes(phase)) fail('phase 仅支持 plan 或 final');
    if (phase === 'final') finalCheck(root, data);
    console.log(`${phase === 'plan' ? '方案结构' : '成稿映射'}检查通过：${data.sections.filter(s => s.kind === 'gate').length} 个关卡，${data.images.length} 张图片。事实与风格仍需独立审核。`);
  }
} catch (e) { console.error(`检查失败：${e.message}`); process.exitCode = 1; }
