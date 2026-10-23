/** Character vocabulary shared by the lightweight launch UI and the renderer. */
export const KIT_REGIONS = ['head','torso','arms','hands','legs','feet'] as const;
export const KIT_STYLES = ['stock','boxy','round','prism'] as const;
export type KitRegion = typeof KIT_REGIONS[number];
export type KitStyle = typeof KIT_STYLES[number];
export type RobotModules = Partial<Record<KitRegion,KitStyle>>;
export const KIT_LABELS: Record<KitStyle,string> = {stock:'Original',boxy:'Tinbot',round:'Orbit',prism:'Prism'};

export function kitRegion(name: string): KitRegion | null {
  if(/head|neck/i.test(name))return 'head';
  if(/ankle|foot|toe|feet/i.test(name))return 'feet';
  if(/hand|wrist|finger|palm/i.test(name))return 'hands';
  if(/arm|shoulder|elbow/i.test(name))return 'arms';
  if(/hip|knee|thigh|calf|leg/i.test(name))return 'legs';
  if(/torso|pelvis|waist|trunk|body|^base$/i.test(name))return 'torso';
  return null;
}
