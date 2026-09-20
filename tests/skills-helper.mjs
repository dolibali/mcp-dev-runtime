import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../dist/config.js';
import { SkillsService } from '../dist/skills/service.js';

export async function skill(root, folder, { name = folder, description = 'Useful project workflow', body = '# Instructions\nUse existing tools.\n', policy, raw, compatibility } = {}) {
  const dir = path.join(root, folder); await mkdir(dir, { recursive: true });
  const text = raw ?? `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${compatibility ? 'compatibility: ' + JSON.stringify(compatibility) + '\n' : ''}---\n${body}`;
  await writeFile(path.join(dir, 'SKILL.md'), text);
  if (policy !== undefined) { await mkdir(path.join(dir, 'agents')); await writeFile(path.join(dir, 'agents/openai.yaml'), policy); }
  return { dir, file: path.join(dir, 'SKILL.md'), text };
}
export async function skillsFixture(t, settings = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mdr-skills-test-')));
  const home = path.join(root, 'home'), project = path.join(root, 'project'), other = path.join(root, 'other');
  await Promise.all([mkdir(home), mkdir(project), mkdir(other)]);
  await writeFile(path.join(project, '.git'), 'gitdir: external-worktree-marker\n');
  await mkdir(path.join(other, '.git'));
  const config = configSchema.parse({ cwd: project, shell: '/bin/bash', port: 0, log_level: 'silent', history: { enabled: false }, skills: settings });
  let clock = Date.now();
  const service = new SkillsService(config, { home, codexHome: path.join(home, '.codex'), now: () => clock });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  return { root, home, project, other, config, service, advance: ms => { clock += ms; },
    global: path.join(home, '.agents/skills'), codex: path.join(home, '.codex/skills'), local: path.join(project, '.agents/skills') };
}
export async function allSkills(service, workdir, query) {
  const rows = []; let cursor;
  do {
    const result = await service.discover({ workdir, ...(query ? { query } : {}), limit: 20, ...(cursor ? { cursor } : {}) });
    rows.push(...result.skills); cursor = result.next_cursor;
  } while (cursor);
  return rows;
}
