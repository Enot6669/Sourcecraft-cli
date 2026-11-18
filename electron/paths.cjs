const path=require('node:path');
function within(root,candidate){const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));}
function resolveWithin(root,relative){if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\0'))throw Error('Invalid path');const candidate=path.resolve(root,relative);if(!within(root,candidate))throw Error('Path escapes project');return candidate;}
module.exports={within,resolveWithin};
