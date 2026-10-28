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
    choose(/waist/.test(id) ? 'Walk with waist control' : 'Walk with arm control', 'Walking & running');
  } else if (/jump|shot/.test(id)) {
    choose(/shot/.test(id) ? 'Shot routine' : 'Walk and jump', 'Dynamic motions');
  } else if (/rough|stair|terrain|plane_encoder|vision_loco/.test(id)) {
    choose(/stair/.test(id) ? 'Stair walking' : /vision/.test(id) ? 'Vision locomotion' : 'Uneven-ground walking', 'Terrain walking');
  } else if (/loco|walk|run|gait|straight_knee/.test(id)) {
    choose(/straight_knee/.test(id) ? 'Straight-knee walking' : /gait/.test(id) ? 'Gait walking' : /(?:^|\/)run$|cpy_run|hybrid_run/.test(id) ? 'Running' : /walkrun|walk_run|amp_locomotion/.test(id) ? 'Walk and run' : 'Walking', 'Walking & running');
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

/** Identifier pieces between separators, with source offsets so labels quote the
 * canonical text exactly (e.g. `0602_20k`, never a re-spelled `0602 20k`). */
function identifierTokens(text: string): { key: string; start: number; end: number }[] {
  const tokens: { key: string; start: number; end: number }[] = [];
  const pattern = /[^/@_\-\s]+/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text))
    tokens.push({ key: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  return tokens;
}

/** For names sharing one friendly title and variant: the part of each identifier that
 * differs, after the shared leading and trailing tokens. Uses the checkpoint leaf when
 * leaves are unique, otherwise the whole canonical name. No meaning is inferred. */
function differingParts(names: readonly string[]): string[] {
  if (names.length < 2) return names.map(() => '');
  const leaves = names.map(name => name.slice(name.lastIndexOf('/') + 1));
  const source = new Set(leaves).size === leaves.length ? leaves : names;
  const split = source.map(identifierTokens);
  const shortest = Math.min(...split.map(tokens => tokens.length));
  let prefix = 0, suffix = 0;
  while (prefix < shortest && split.every(tokens => tokens[prefix].key === split[0][prefix].key)) prefix++;
  while (suffix < shortest - prefix &&
    split.every(tokens => tokens[tokens.length - 1 - suffix].key === split[0][split[0].length - 1 - suffix].key)) suffix++;
  return source.map((text, i) => {
    const kept = split[i].slice(prefix, split[i].length - suffix);
    return kept.length ? text.slice(kept[0].start, kept[kept.length - 1].end) : '';
  });
}

/** Short gallery/trigger text per canonical name. A unique title stays bare; a shared title
 * adds the declared variant (when the group spans several) and the differing identifier part.
 * Any title group involved in a remaining collision falls back entirely to the full option label
 * (`policyPresentation().label`, which the picker then shows unshortened), so final labels are distinct. */
export function compactPolicyLabels(entries: readonly { name: string; variant: string }[]): Map<string, string> {
  const byTitle = new Map<string, { name: string; variant: string }[]>();
  const full = new Map<string, string>(), titleOf = new Map<string, string>();
  for (const entry of entries) {
    const { title, label } = policyPresentation(entry.name);
    full.set(entry.name, label); titleOf.set(entry.name, title);
    const list = byTitle.get(title);
    if (list) list.push(entry); else byTitle.set(title, [entry]);
  }
  const labels = new Map<string, string>();
  for (const [title, list] of byTitle) {
    const tagVariant = new Set(list.map(entry => entry.variant)).size > 1;
    const byVariant = new Map<string, string[]>();
    for (const { name, variant } of list) {
      const key = tagVariant ? variant : '', names = byVariant.get(key);
      if (names) names.push(name); else byVariant.set(key, [name]);
    }
    for (const [variant, names] of byVariant) {
      const parts = differingParts(names);
      names.forEach((name, i) => labels.set(name, [title, variant, parts[i]].filter(Boolean).join(' · ')));
    }
  }
  // Each pass converts at least one still-compact group, so this ends after at most one pass per title.
  for (;;) {
    const owners = new Map<string, string[]>();
    for (const [name, label] of labels) {
      const names = owners.get(label);
      if (names) names.push(name); else owners.set(label, [name]);
    }
    const conflicting = new Set<string>();
    for (const names of owners.values()) if (names.length > 1)
      for (const name of names) if (labels.get(name) !== full.get(name)) conflicting.add(titleOf.get(name)!);
    if (!conflicting.size) return labels;
    for (const title of conflicting) for (const { name } of byTitle.get(title)!) labels.set(name, full.get(name)!);
  }
}
