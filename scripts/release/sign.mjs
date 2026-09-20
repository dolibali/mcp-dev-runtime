// Reserved pipeline boundary. Do not silently claim a signature exists.
export async function signBundle(_root, mode = process.env.MDR_SIGNING_MODE ?? 'skip') {
  if (mode !== 'skip') throw new Error('Signing is not configured. This release supports MDR_SIGNING_MODE=skip only. Add a reviewed signer/notarization step here before enabling signing.');
  console.log('[release] Publisher code signing and Apple notarization: SKIPPED (unsigned distribution).');
  return { publisher_signature: 'skipped', apple_notarization: 'skipped', reason: 'Explicit unsigned release; upstream/ad-hoc component signatures are not a publisher signature.' };
}
