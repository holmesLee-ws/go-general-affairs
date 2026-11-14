#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계, 국내 근거 조문의 출처 대조(R11), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교", "근거"];

function parseCurriculum(text) {
  const modules = new Map();
  const domestic = new Map();
  const global = new Map();
  const problems = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([GCDAFWX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
    domestic.set(id, fields["국내 근거"] || "");
    global.set(id, fields["글로벌 비교"] || "");
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, domestic, global, problems };
}


// sources.md 표: | 법령·기준명 | 확인한 조문 | URL | 조회일 |
function parseSources(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const c = line.split("|").map((s) => s.trim());
    if (c.length < 6 || !/^https?:\/\//.test(c[3]) || !/^\d{4}-\d{2}-\d{2}$/.test(c[4])) continue;
    const arts = new Set((c[2].match(/제\d+조(?:의\d+)?/g) || []));
    rows.set(c[1], arts);
  }
  return rows;
}

// 법으로 끝나지만 법령 이름이 아닌 낱말
const NOT_LAW = new Set(["방법", "불법", "위법", "적법", "합법", "편법", "문법", "기법", "용법", "화법", "수법", "법", "입법", "사법", "헌법상"]);
const PARTICLE = /(?:에서|으로|에|의|을|를|은|는|이|가|과|와|로|도|상|과의|에서의|에\s?따른)$/;

function checkDomestic(domestic, sources) {
  const problems = [];
  const names = [...sources.keys()].sort((a, b) => b.length - a.length);
  const lastWords = new Set(names.map((n) => n.replace(/\([^)]*\)/g, "").trim().split(/\s+/).pop()));
  for (const [id, line] of domestic) {
    if (/^해당\s?없음/.test(line)) {
      if (!/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 국내 근거 「해당 없음」의 이유가 없거나 짧음`);
    } else if (!names.some((n) => line.includes(n))) problems.push(`${id}: 국내 근거에 sources.md의 법령명이 없음(자리표시자 금지)`);
    // 조문은 바로 앞(공백만 사이에 둔)의 법령명에 붙는다
    for (const m of line.matchAll(/제\d+조(?:의\d+)?/g)) {
      const before = line.slice(0, m.index).replace(/\s+$/, "");
      const owner = names.find((n) => before.endsWith(n));
      if (!owner) { problems.push(`${id}: ${m[0]} 바로 앞의 법령명이 sources.md에 없음`); continue; }
      if (!sources.get(owner).has(m[0])) problems.push(`${id}: ${owner} ${m[0]}이 sources.md에서 확인되지 않음`);
    }
    // 「…법」·「…법률」로 끝나는 낱말은 모두 sources.md 법령명의 끝 낱말이어야 한다
    const bare = line.replace(/\([^)]*\)/g, " ");
    for (const raw of bare.split(/[\s,·「」—]+/)) {
      const w = raw.replace(PARTICLE, "");
      if (!/[가-힣](?:법|법률)$/.test(w) || NOT_LAW.has(w)) continue;
      if (!lastWords.has(w)) problems.push(`${id}: 법령명 「${w}」이 sources.md에 없음`);
    }
    for (const n of line.matchAll(/[가-힣]+(?:시행령|시행규칙|심사지침|실시요령|안내서|가이드라인|고시|규칙|지침)(?=[\s,(·]|$)/g))
      if (!names.some((x) => x.includes(n[0]))) problems.push(`${id}: 기준명 「${n[0]}」이 sources.md에 없음`);
  }
  return problems;
}

// 글로벌 비교 줄의 식별자(CFR·U.S.C.·EU 문서 번호·조항·기관명)가 sources.md 글로벌 표에 있는지 본다
const GLOBAL_KEYS = [/ISO(?:\/IEC)? \d{4,5}(?:-\d)?(?::\d{4})?/g, /\d+ U\.S\.C\./g, /(?:\(EU\) No )?\d{3,4}\/\d{4}/g, /Rule \d+\(e\)/g, /Publication \d+/g, /s\.\d+[A-Z]?/g, /§\d+(?:\([a-z]\))?/g,
  /\b(?:GDPR|eIDAS|ESIGN|EDPB|ERISA|NFPA \d+|IPMS|RICS|Companies House|Companies Act \d{4}|Fire Safety\) Order \d{4}|Compulsory Insurance\) Act \d{4}|World Commerce & Contracting)\b/g];
function checkGlobal(global, sourcesText) {
  const problems = [];
  const table = sourcesText.split("## 글로벌")[1] || "";
  for (const [id, line] of global) {
    if (/^해당\s?없음/.test(line)) { if (!/^해당 없음 — .{8,}/.test(line)) problems.push(`${id}: 글로벌 비교 「해당 없음」의 이유가 없거나 짧음`); continue; }
    if (!GLOBAL_KEYS.some((re) => line.match(re))) problems.push(`${id}: 글로벌 비교에 식별 가능한 기준(ISO 번호·법령 조항·기관명)이 없음(자리표시자 금지)`);
    for (const re of GLOBAL_KEYS) for (const m of line.matchAll(re)) {
      const key = m[0].replace(/^\(EU\) /, "").replace(/§(\d+)\.\d+$/, "Part $1");
      const k2 = key.replace(/ Part /, " §").replace(/ §/, " Part ");
      if (!table.includes(key) && !table.includes(k2) && !table.includes(m[0])) problems.push(`${id}: 글로벌 근거 「${m[0]}」이 sources.md 글로벌 표에 없음`);
    }
  }
  return problems;
}

function checkGraduation(text) {
  const i = text.indexOf("## 졸업 산출물 (X1)");
  if (i < 0) return ["tutor/assessment.md에 「## 졸업 산출물 (X1)」 절 없음"];
  const sec = text.slice(i).split(/\n## /)[0];
  const need = ["learner/projects/", "문서 보존 기준표", "법인 행정 캘린더", "① 보존 기간", "② 기산점", "③ 국내 근거", "④ 출처 URL", "⑤ 보관 형태", "⑥ 기간 만료", "보존 예외",
    "상업장부", "세무 증빙", "근로 서류", "의사록", "개인정보가 든 문서", "계약서", "내부 기준 — 이유",
    "① 기산 사건", "② 기한", "③ 근거", "④ 출처 URL", "⑤ 담당", "⑥ 놓쳤을", "정기주총", "임원 임기", "변경등기", "인감", "건물 법정 점검", "보험 만기", "문서 파기", "직책"];
  return need.filter((n) => !sec.includes(n)).map((n) => `tutor/assessment.md 졸업 산출물 절에 「${n}」 없음`);
}

// R11 숫자 규칙: 국내 근거·글로벌 비교 줄에 보존 기간·기한·금액 숫자를 쓰지 않는다
const NUMBER_RE = /\d+\s?(?:년|개월|일|주|회|%|원|만|천|시간|배|days?|months?|years?|weeks?|hours?)\b|\d+\s?(?:년|개월|일|주|회|%|원|만|천|시간|배)|매년|매월|매분기|지체 ?없이|즉시|이내|열흘|하루|이틀|사흘|(?:한|두|세|네|다섯|여섯) ?(?:달|해)|반년|(?:within|every) \w+/gi;
function checkNumbers(domestic, global) {
  const problems = [];
  for (const [kind, map] of [["국내 근거", domestic], ["글로벌 비교", global]])
    for (const [id, line] of map) for (const m of line.matchAll(NUMBER_RE)) problems.push(`${id}: ${kind}에 숫자·기한 표현 「${m[0]}」 — 세션 중 조회로만 말한다`);
  return problems;
}

function findVisualAssets(files) {
  return files.filter((f) => /\.(x?html?|css|svgz?|png|jpe?g|gif|webp|avif|ico|bmp|pdf)$/i.test(f) || (/\.(m?js|cjs|jsx|tsx?)$/i.test(f) && f !== "tools/check.mjs"));
}

// 학습자 경로의 지침은 본문 전체에서, 구축 기록(docs/build)은 코드 블록에서만 마크업을 찾는다
const MARKUP = /<(!doctype|html|svg|style|canvas|script)\b/i;
function findTemplateMarkup(name, text) {
  if (!name.startsWith("docs/build/")) return MARKUP.test(text) ? [name] : [];
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (MARKUP.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const { modules, domestic, global, problems } = parseCurriculum(read("curriculum/map.md"));
  errors.push(...problems);
  if (!existsSync(join(root, "docs/build/sources.md"))) errors.push("docs/build/sources.md 없음");
  else {
    const src = read("docs/build/sources.md");
    errors.push(...checkDomestic(domestic, parseSources(src)), ...checkGlobal(global, src));
  }
  errors.push(...checkGraduation(read("tutor/assessment.md")), ...checkNumbers(domestic, global));
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => /\.(md|markdown|txt)$/i.test(x) && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 파일 ${files.length}개 검사`);
}

main();
