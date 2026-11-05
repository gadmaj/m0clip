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
