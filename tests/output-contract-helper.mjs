import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJsonSchema } from '@modelcontextprotocol/server';
export const contracts = JSON.parse(readFileSync(new URL('../contracts/tools.json', import.meta.url), 'utf8')).tools;
export const validators = new Map(contracts.map(t => [t.name, fromJsonSchema(t.outputSchema)]));
export async function assertOutput(name, result) {
  assert(result.structuredContent !== undefined, `${name}: structuredContent is required`);
  const check = await validators.get(name)['~standard'].validate(result.structuredContent);
  assert(!check.issues, `${name}: ${JSON.stringify(check.issues)}`);
  const wire = JSON.parse(JSON.stringify(result));
  const wireCheck = await validators.get(name)['~standard'].validate(wire.structuredContent);
  assert(!wireCheck.issues, `${name} serialized: ${JSON.stringify(wireCheck.issues)}`);
  const text = wire.content.find(c => c.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  const newline = text.indexOf('\n');
  const header = newline < 0 ? text : text.slice(0, newline);
  const textOutput = newline < 0 ? '' : text.slice(newline + 1);
  const {output, ...metadata} = wire.structuredContent;
  assert.deepEqual(JSON.parse(header), metadata, `${name}: text metadata differs from structuredContent metadata`);
  if (['exec_command', 'write_stdin'].includes(name) && Object.hasOwn(metadata, 'session_id')) {
    assert.equal(typeof output, 'string', `${name}: structured output is required, including empty chunks`);
    assert(newline >= 0, `${name}: legacy text envelope is required`);
    assert.equal(output, textOutput, `${name}: text and structured output chunks differ`);
    assert.equal(Buffer.byteLength(output), metadata.next_output_cursor - metadata.output_start, `${name}: output byte length differs from cursor range`);
  } else {
    assert(!Object.hasOwn(wire.structuredContent, 'output'), `${name}: unexpected output field`);
  }
  assert(!Object.hasOwn(wire.structuredContent, 'data'), 'Do not duplicate image bytes');
  return {...wire.structuredContent, output: output ?? textOutput, isError: wire.isError};
}
export async function assertInvalid(name, data) {
  const checked = await validators.get(name)['~standard'].validate(data);
  assert(checked.issues?.length, `${name}: malformed output was accepted`);
}
