// Short unique ids for marks, anchors and videos (unique within a session and across saves).
let uid = 0;
export const newId = (prefix = 'id') => `${prefix}${Date.now().toString(36)}${(uid++).toString(36)}`;
