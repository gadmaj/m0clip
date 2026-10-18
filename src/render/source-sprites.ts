/** SpriteInstance.prepareToRender's distance fade and scale (noclip.website Sprite.ts).
 * Copyright (c) 2018 Jasper St. Pierre, MIT; see LICENSE.noclip. */
export function sourceSpriteState(mode:number,distanceMeters:number) {
  if(mode!==3&&mode!==9)return{alpha:1,scale:1};
  const distance=distanceMeters/.0254;
  return{alpha:Math.min(1,1200*1200/Math.max(distance*distance,1)),scale:mode===3?distance/200:1};
}
