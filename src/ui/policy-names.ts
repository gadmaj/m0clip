/** Presentation only. Canonical identifiers remain unchanged for inference,
 * saved selections, remote transitions, recordings and exported packs. */
export function policyPresentation(name: string): { title: string; label: string; category: string; description: string } {
  const id = name.toLowerCase();
  let title = '', category = '', description = '';
  const choose = (t: string, c: string, d: string) => { title = t; category = c; description = d; };
  if (/getup|qishen|gunfanqishen|squat2stand|one_key_break/.test(id)) {
    choose(/stand2squat/.test(id) ? 'Lower into a squat' : /squat2stand/.test(id) ? 'Stand from a squat' : /facedown|face_down/.test(id) ? 'Get up from face down' : /faceup/.test(id) ? 'Get up from face up' : 'Get up', 'Recovery & poses', 'A trained recovery or pose transition. Start from the pose expected by this policy.');
  } else if (/tangxia/.test(id)) {
    choose('Lie down', 'Recovery & poses', 'A trained transition to a lying pose.');
  } else if (/punch|fight|gongfu|jiequandao|lixiaolong/.test(id)) {
    choose(/gongfu/.test(id) ? 'Kung fu routine' : /jiequandao|lixiaolong/.test(id) ? 'Martial arts routine' : /punch/.test(id) ? 'Boxing' : 'Fighting routine', 'Martial arts', 'A trained martial arts motion; use its listed remote actions when available.');
  } else if (/dance|weibosite|niuniuwu|cxk/.test(id)) {
    const segment = id.match(/segment(\d+)/)?.[1];
    choose(segment ? `Dance routine · part ${segment}` : /niuniuwu/.test(id) ? 'Niuniu dance' : /weibosite/.test(id) ? 'Weibosite dance' : 'Dance routine', 'Dance & gestures', 'Plays the learned dance sequence. Checkpoints and robot variants remain individually selectable.');
  } else if (/hello/.test(id)) {
    choose('Greeting', 'Dance & gestures', 'A trained greeting gesture.');
  } else if (/armsdk|arm_sdk|waist_control|alljoint/.test(id)) {
    choose(/waist/.test(id) ? 'Walk with waist control' : 'Walk with arm control', 'Walking & running', 'Locomotion with separate upper-body control, as supported by this policy.');
  } else if (/jump|shot/.test(id)) {
    choose(/shot/.test(id) ? 'Shot routine' : 'Walk and jump', 'Dynamic motions', 'A trained dynamic motion. Available actions depend on the selected checkpoint.');
  } else if (/rough|stair|terrain|plane_encoder|vision_loco/.test(id)) {
    choose(/stair/.test(id) ? 'Stair walking' : /vision/.test(id) ? 'Vision locomotion' : 'Uneven-ground walking', 'Terrain walking', 'Locomotion trained for terrain; required observations depend on the original policy configuration.');
  } else if (/loco|walk|run|gait|straight_knee/.test(id)) {
    choose(/straight_knee/.test(id) ? 'Straight-knee walking' : /gait/.test(id) ? 'Gait walking' : /(?:^|\/)run$|cpy_run|hybrid_run/.test(id) ? 'Running' : /walkrun|walk_run|amp_locomotion/.test(id) ? 'Walk and run' : 'Walking', 'Walking & running', 'Use the movement controls when this policy accepts commands. Original checkpoint identifiers are shown in parentheses.');
  } else if (/mimic|actor|amp_motion|traj_/.test(id)) {
    choose(/classic_movie/.test(id) ? 'Movie motion routine' : /interaction/.test(id) ? 'Interaction motions' : 'Motion imitation', 'Motion imitation', 'Reproduces learned reference motions. See this policy’s remote actions and notices for its supported controls.');
  } else {
    // Imported third-party packs still get a readable label without guessing a task.
    title = (name.split('/').pop() ?? name).replace(/[_-]+/g, ' ').replace(/^\d+\s+/, '').trim() || name;
    title = title.charAt(0).toUpperCase() + title.slice(1);
    category = 'Other policies'; description = 'Imported policy. Its full original identifier is retained below.';
  }
  return { title, label: `${title} (${name})`, category, description };
}
