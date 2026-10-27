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
