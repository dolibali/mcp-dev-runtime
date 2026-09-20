import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fixture } from '../helpers.mjs';
import { ImageReader } from '../../dist/runtime/image-reader.js';
for (const format of ['png','jpeg','webp']) test(`image: ${format} returns real decodable ImageContent`,async t=>{
  const c=await fixture(t);const p=path.join(c.cwd,`test.${format}`);await sharp({create:{width:12,height:8,channels:3,background:'#123456'}})[format]().toFile(p);
  const r=await new ImageReader(c).read({path:p});assert.equal(r.image.type,'image');assert.equal(r.image.mimeType,`image/${format}`);
  const metadata=await sharp(Buffer.from(r.image.data,'base64')).metadata();assert.equal(metadata.width,12);assert.equal(metadata.height,8);
});
test('image: resizing and base64 budget do not modify original file',async t=>{
  const c=await fixture(t,{image:{max_output_dimension:100,max_encoded_bytes:4096}});const p=path.join(c.cwd,'large.png');
  await sharp({create:{width:500,height:300,channels:3,background:'#abcdef'}}).png().toFile(p);const before=await fs.readFile(p);
  const r=await new ImageReader(c).read({path:'large.png'});assert(r.metadata.resized);assert(r.metadata.width<=100);assert(r.image.data.length<=4096);assert.deepEqual(await fs.readFile(p),before);
});
test('image: wrong content, SVG and missing files fail explicitly',async t=>{
  const c=await fixture(t);const r=new ImageReader(c);await fs.writeFile(path.join(c.cwd,'fake.png'),'not an image');
  await fs.writeFile(path.join(c.cwd,'a.svg'),'<svg></svg>');
  for(const p of ['fake.png','a.svg','missing.png'])await assert.rejects(r.read({path:p}));
});
test('image: input byte and pixel limits apply before expensive decoding',async t=>{
  const c=await fixture(t,{image:{max_input_pixels:10}});await sharp({create:{width:12,height:8,channels:3,background:'#333333'}}).png().toFile(path.join(c.cwd,'a.png'));
  await assert.rejects(new ImageReader(c).read({path:'a.png'}));
});
