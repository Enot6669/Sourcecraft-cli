const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const {within,resolveWithin}=require('./paths.cjs');
test('accept project child',()=>assert.equal(resolveWithin('/tmp/demo','src/main.js'),path.resolve('/tmp/demo/src/main.js')));
test('reject traversal',()=>assert.throws(()=>resolveWithin('/tmp/demo','../secrets')));
test('reject absolute',()=>assert.throws(()=>resolveWithin('/tmp/demo','/etc/passwd')));
test('reject sibling',()=>assert.equal(within('/tmp/demo','/tmp/demo2/a'),false));
