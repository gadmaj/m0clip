/** Activity sections in gallery order; robot variants are card detail, never sections. */
const POLICY_ACTIVITIES = ['Locomotion', 'Dynamic motions', 'Dance & gestures', 'Martial arts',
  'Motion imitation', 'Recovery & poses', 'Other policies'] as const;

/** Presentation only. Canonical identifiers remain unchanged for inference,
 * saved selections, remote transitions, recordings and exported packs. */
export function policyPresentation(name: string): { title: string; label: string; category: string; description: string } {
  const id = name.toLowerCase();
  let title = '', category = '', description = '';
  const choose = (t: string, c: string, d = '') => { title = t; category = c; description = d; };
  if (/getup|qishen|gunfanqishen|squat2stand|one_key_break/.test(id)) {
    choose(/stand2squat/.test(id) ? 'Lower into a squat' : /squat2stand/.test(id) ? 'Stand from a squat' : /facedown|face_down/.test(id) ? 'Get up from face down' : /faceup/.test(id) ? 'Get up from face up' : 'Get up', 'Recovery & poses', 'Start in the required pose.');
  } else if (/tangxia/.test(id)) {
    choose('Lie down', 'Recovery & poses');
  } else if (/punch|fight|gongfu|jiequandao|lixiaolong/.test(id)) {
    choose(/gongfu/.test(id) ? 'Kung fu routine' : /jiequandao|lixiaolong/.test(id) ? 'Martial arts routine' : /punch/.test(id) ? 'Boxing' : 'Fighting routine', 'Martial arts');
  } else if (/dance|weibosite|niuniuwu|cxk/.test(id)) {
    const segment = id.match(/segment(\d+)/)?.[1];
    choose(segment ? `Dance routine · part ${segment}` : /niuniuwu/.test(id) ? 'Niuniu dance' : /weibosite/.test(id) ? 'Weibosite dance' : 'Dance routine', 'Dance & gestures');
  } else if (/hello/.test(id)) {
    choose('Greeting', 'Dance & gestures');
  } else if (/armsdk|arm_sdk|waist_control|alljoint/.test(id)) {
    choose(/waist/.test(id) ? 'Walk with waist control' : 'Walk with arm control', 'Locomotion');
  } else if (/jump|shot/.test(id)) {
    choose(/shot/.test(id) ? 'Shot routine' : 'Walk and jump', 'Dynamic motions');
  } else if (/rough|stair|terrain|plane_encoder|vision_loco/.test(id)) {
    choose(/stair/.test(id) ? 'Stair walking' : /vision/.test(id) ? 'Vision locomotion' : 'Uneven-ground walking', 'Locomotion');
  } else if (/loco|walk|run|gait|straight_knee/.test(id)) {
    choose(/straight_knee/.test(id) ? 'Straight-knee walking' : /gait/.test(id) ? 'Gait walking' : /(?:^|\/)run$|cpy_run|hybrid_run/.test(id) ? 'Running' : /walkrun|walk_run|amp_locomotion/.test(id) ? 'Walk and run' : 'Walking', 'Locomotion');
  } else if (/mimic|actor|amp_motion|traj_/.test(id)) {
    choose(/classic_movie/.test(id) ? 'Movie motion routine' : /interaction/.test(id) ? 'Interaction motions' : 'Motion imitation', 'Motion imitation');
  } else {
    // Imported third-party packs still get a readable label without guessing a task.
    title = (name.split('/').pop() ?? name).replace(/[_-]+/g, ' ').replace(/^\d+\s+/, '').trim() || name;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    category = 'Other policies';
  }
  return { title, label: `${title} (${name})`, category, description };
}

/** Declared robot variants: 0 Air-only, 1 Air + EDU, 2 EDU-only, 3 undeclared. */
export function policyVariantRank(models?: readonly string[]): number {
  if (!models?.length) return 3;
  const air = models.includes('air'), edu = models.includes('edu');
  return air && !edu ? 0 : air ? 1 : 2;
}

/** Declared variant without the robot family word, which the selected robot already names. */
export function policyVariantLabel(models?: readonly string[]): string {
  return ['Air', 'Air + EDU', 'EDU', ''][policyVariantRank(models)];
}

/** Identifier pieces between separators, with source offsets so tags quote the canonical
 * text exactly (`0602_20k`, never a re-spelled `0602 20k`). */
function identifierTokens(text: string): { key: string; start: number; end: number }[] {
  const tokens: { key: string; start: number; end: number }[] = [];
  const pattern = /[^/@_\-\s]+/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text))
    tokens.push({ key: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  return tokens;
}

const distinct = (values: readonly string[]) => new Set(values).size === values.length;

/** Checkpoint leaves (or, with `paths` when leaves repeat, whole names) after the leading and trailing
 * tokens they all share, quoted verbatim; a lone entry needs none. Leading or trailing tokens that only
 * repeat the family or the policy's own variant (`r1air`, `air`, `g1`) are also dropped when the results
 * stay distinct. Undefined when no distinct quote exists. */
function checkpointTags(entries: readonly { name: string; models?: readonly string[] }[], family: string, paths = false): string[] | undefined {
  if (entries.length < 2) return entries.map(() => '');
  const leaves = entries.map(({ name }) => name.slice(name.lastIndexOf('/') + 1));
  const source = distinct(leaves) ? leaves : paths ? entries.map(({ name }) => name) : leaves;
  if (!distinct(source)) return undefined;
  const split = source.map(identifierTokens);
  const shortest = Math.min(...split.map(tokens => tokens.length));
  let prefix = 0, suffix = 0;
  while (prefix < shortest && split.every(tokens => tokens[prefix].key === split[0][prefix].key)) prefix++;
  while (suffix < shortest - prefix &&
    split.every(tokens => tokens[tokens.length - 1 - suffix].key === split[0][split[0].length - 1 - suffix].key)) suffix++;
  const start = prefix, end = split.map(tokens => tokens.length - suffix);
  const quote = (i: number, from: number, to: number) =>
    from < to ? source[i].slice(split[i][from].start, split[i][to - 1].end) : '';
  const tags = source.map((_, i) => quote(i, start, end[i]));
  const trimmed = entries.map(({ models }, i) => {
    const implied = new Set([family, ...(models ?? []).flatMap(model => [model, `${family}${model}`])]);
    let from = start, to = end[i];
    while (from < to && implied.has(split[i][from].key)) from++;
    while (to > from && implied.has(split[i][to - 1].key)) to--;
    return quote(i, from, to);
  });
  return distinct(trimmed) ? trimmed : distinct(tags) ? tags : undefined;
}

const joinTitle = (...parts: string[]) => parts.filter(Boolean).join(' · ');

/** The same leaf in several variants: the variant, then the checkpoint within it (exact name when needed). */
function variantCheckpointTags(list: readonly { name: string; models?: readonly string[] }[], variants: readonly string[], family: string): string[] {
  const spans = !variants.every(variant => variant === variants[0]);
  const byVariant = new Map<string, number[]>();
  variants.forEach((variant, i) => byVariant.set(variant, [...byVariant.get(variant) ?? [], i]));
  const tags = list.map(entry => entry.name);
  for (const indices of byVariant.values()) {
    const parts = checkpointTags(indices.map(i => list[i]), family, true);
    if (parts) indices.forEach((i, k) => { tags[i] = joinTitle(spans ? variants[i] : '', parts[k]); });
  }
  return tags;
}

/** Short visible title per canonical name: the activity title alone when it is unique, otherwise the
 * title plus the least needed to tell its cards apart, in order: the variant (`Lie down · Air`), the
 * differing part of the checkpoint (`Walking · 22500amp6_cwdata_015`), or both
 * (`Kung fu routine · EDU · new_urdf_50k`). Never the family word; the canonical name stays the
 * value and accessible identity. Titles that would still repeat use the whole canonical name. */
export function compactPolicyTitles(entries: readonly { name: string; models?: readonly string[] }[], family = ''): Map<string, string> {
  const robot = family.toLowerCase();
  const byTitle = new Map<string, { name: string; models?: readonly string[] }[]>();
  for (const entry of entries) {
    const title = policyPresentation(entry.name).title, list = byTitle.get(title);
    if (list) list.push(entry); else byTitle.set(title, [entry]);
  }
  const titles = new Map<string, string>();
  for (const [title, list] of byTitle) {
    const variants = list.map(entry => policyVariantLabel(entry.models));
    const tags = list.length < 2 ? [''] : distinct(variants) ? variants
      : checkpointTags(list, robot) ?? variantCheckpointTags(list, variants, robot);
    list.forEach((entry, i) => titles.set(entry.name, joinTitle(title, tags[i])));
  }
  // Any remaining repeat (an imported name that reads like another title) falls back to exact names.
  const owners = new Map<string, string[]>();
  for (const [name, title] of titles) owners.set(title, [...owners.get(title) ?? [], name]);
  for (const names of owners.values()) if (names.length > 1)
    for (const name of names) titles.set(name, joinTitle(policyPresentation(name).title, name));
  return titles;
}

/** Activity sections in POLICY_ACTIVITIES order. Within a section, policies the worker would run on the
 * running robot's body (`_air` spec or not, from `previewRobot`) come first; every other policy stays listed
 * after them. Both parts keep the Air-only, Air + EDU, EDU-only, FSM State, name order. */
export function policySections<T extends { name: string; previewRobot: string; fsmId?: number; models?: string[] }>(
  entries: readonly T[], robotSpec = ''): [string, T[]][] {
  const other = (e: T) => robotSpec && e.previewRobot.endsWith('_air') !== robotSpec.endsWith('_air') ? 1 : 0;
  const ordered = [...entries].sort((a, b) => other(a) - other(b)
    || policyVariantRank(a.models) - policyVariantRank(b.models)
    || (a.fsmId ?? 1e9) - (b.fsmId ?? 1e9) || a.name.localeCompare(b.name));
  const sections = new Map<string, T[]>();
  for (const e of ordered) {
    const category = policyPresentation(e.name).category;
    const list = sections.get(category);
    if (list) list.push(e); else sections.set(category, [e]);
  }
  const activities: readonly string[] = POLICY_ACTIVITIES;
  return [...sections].sort((a, b) => activities.indexOf(a[0]) - activities.indexOf(b[0]));
}
