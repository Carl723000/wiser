import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCandidateConversionHostRunner } from '../src/adapters/candidate-conversion-host.js';
import { wordStructure } from './candidate-conversion-fixture.js';

// Executable fixtures exercise OS process boundaries, not real Word conversion.
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture(
  options: { converter?: string; extractor?: string; timeout?: number } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), 'wiser-conversion-host-test-'));
  folders.push(folder);
  const converter = join(folder, 'converter');
  const source =
    '#!' +
    process.execPath +
    '\n' +
    (options.converter ??
      `
    const fs=require('node:fs'),path=require('node:path');
    if(process.argv.includes('--version')) process.stdout.write('LibreOffice 25.8.1.1\\n');
    else {
      const args=process.argv.slice(2);
      const profile=args.find(a=>a.startsWith('-env:UserInstallation='));
      if(!profile || !profile.includes('file:')) process.exit(5);
      fs.writeFileSync(path.join(args[args.indexOf('--outdir')+1],'source.docx'), fs.readFileSync(args.at(-1)));
    }`);
  await writeFile(converter, source, { mode: 0o700 });
  const script = join(folder, 'structure.cjs');
  const extractor =
    options.extractor ??
    `process.stdout.write(JSON.stringify({kind:'STRUCTURE',structure:${JSON.stringify(wordStructure)}}));`;
  await writeFile(script, extractor);
  const config = {
    converter: {
      executablePath: converter,
      sha256: createHash('sha256').update(source).digest('hex'),
      version: 'LibreOffice 25.8.1.1',
      platform: process.platform,
    },
    structure: {
      pythonPath: process.execPath,
      scriptPath: script,
      scriptSha256: createHash('sha256').update(extractor).digest('hex'),
    },
    temporaryRoot: folder,
    maximumMilliseconds: options.timeout ?? 2000,
    authorityIntervalMilliseconds: 20,
  };
  return {
    folder,
    converter,
    config,
    runner: createCandidateConversionHostRunner(config),
  };
}
describe('explicit private bounded conversion host', () => {
  it('propagates a synchronous authority throw during the child loop', async () => {
    const f = await fixture({ extractor: 'setInterval(()=>{},1000);' });
    const denied = new Error('synthetic synchronous authority loss');
    let checks = 0;
    await expect(
      f.runner.extractStructure({
        bytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: () => {
          if (++checks === 3) throw denied;
          return Promise.resolve();
        },
      }),
    ).rejects.toBe(denied);
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it('rejects invalid UTF-8 instead of silently replacing original text', async () => {
    const f = await fixture({
      extractor: `const bytes=Buffer.from(${JSON.stringify(JSON.stringify({ kind: 'STRUCTURE', structure: wordStructure }))}); const at=bytes.indexOf(Buffer.from('潮白河')); bytes[at]=255; process.stdout.write(bytes);`,
    });
    expect(
      await f.runner.extractStructure({
        bytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual({ kind: 'UNVERIFIABLE', reason: 'INVALID_STRUCTURE' });
  });
  it('refuses an observed version that does not match the trusted pin', async () => {
    const f = await fixture({
      converter: "process.stdout.write('LibreOffice 25.8.2.1');",
    });
    expect(
      await f.runner.reconvert({
        originalBytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual({ kind: 'UNVERIFIABLE', reason: 'TOOL_UNAVAILABLE' });
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it('rejects output larger than the admitted byte budget and cleans it', async () => {
    const f = await fixture({
      converter:
        "const fs=require('node:fs'),path=require('node:path'); if(process.argv.includes('--version')) process.stdout.write('LibreOffice 25.8.1.1'); else {const args=process.argv.slice(2);fs.writeFileSync(path.join(args[args.indexOf('--outdir')+1],'source.docx'),Buffer.alloc(2048));}",
    });
    expect(
      await f.runner.reconvert({
        originalBytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual({ kind: 'UNVERIFIABLE', reason: 'BUDGET_EXCEEDED' });
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it('propagates extraction authority errors and cleans the child directory', async () => {
    const f = await fixture({ extractor: 'setInterval(()=>{},1000);' });
    const denied = new Error('synthetic extraction authority loss');
    let checks = 0;
    await expect(
      f.runner.extractStructure({
        bytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
          if (++checks === 3) throw denied;
        },
      }),
    ).rejects.toBe(denied);
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it('discovers the pinned executable identity and uses an isolated profile before cleanup', async () => {
    const f = await fixture();
    let checks = 0;
    const input = {
      originalBytes: new TextEncoder().encode('synthetic DOC bytes'),
      maximumBytes: 1024,
      checkAuthority: async () => {
        checks++;
        await Promise.resolve();
      },
    };
    const result = await f.runner.reconvert(input);
    expect(result).toMatchObject({
      kind: 'CONVERTED',
      bytes: input.originalBytes,
      tool: {
        name: 'LibreOffice',
        version: 'LibreOffice 25.8.1.1',
        digest: f.config.converter.sha256,
      },
    });
    expect(checks).toBeGreaterThanOrEqual(3);
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
    expect(
      await f.runner.extractStructure({
        bytes: input.originalBytes,
        maximumBytes: 1024,
        checkAuthority: input.checkAuthority,
      }),
    ).toEqual(wordStructure);
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it('rejects unpinned, changed, and prerelease identities', async () => {
    const f = await fixture();
    await writeFile(
      f.converter,
      (await readFile(f.converter, 'utf8')) + '\n// changed',
    );
    expect(
      await f.runner.reconvert({
        originalBytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual({ kind: 'UNVERIFIABLE', reason: 'TOOL_UNAVAILABLE' });
    expect(() =>
      createCandidateConversionHostRunner({
        ...f.config,
        converter: {
          ...f.config.converter,
          version: 'LibreOfficeDev 26.8.0.0.alpha0',
        },
      }),
    ).toThrow();
  });
  it('retains timeout and ordinary exit failures as honest outcomes', async () => {
    for (const [converter, reason] of [
      [
        "if(process.argv.includes('--version')) process.stdout.write('LibreOffice 25.8.1.1'); else setInterval(()=>{},1000);",
        'BUDGET_EXCEEDED',
      ],
      [
        "if(process.argv.includes('--version')) process.stdout.write('LibreOffice 25.8.1.1'); else process.exit(3);",
        'CONVERSION_FAILED',
      ],
    ] as const) {
      const f = await fixture({
        converter,
        timeout: reason === 'BUDGET_EXCEEDED' ? 500 : 2000,
      });
      expect(
        await f.runner.reconvert({
          originalBytes: new Uint8Array([1]),
          maximumBytes: 1024,
          checkAuthority: async () => {
            await Promise.resolve();
          },
        }),
      ).toEqual({ kind: 'UNVERIFIABLE', reason });
      expect((await readdir(f.folder)).sort()).toEqual([
        'converter',
        'structure.cjs',
      ]);
    }
  });
  it('propagates authority errors while terminating the child and cleaning the profile', async () => {
    const f = await fixture({
      converter:
        "if(process.argv.includes('--version')) process.stdout.write('LibreOffice 25.8.1.1'); else setInterval(()=>{},1000);",
    });
    const authorityError = new Error('synthetic lease lost');
    let checks = 0;
    await expect(
      f.runner.reconvert({
        originalBytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
          if (++checks === 4) throw authorityError;
        },
      }),
    ).rejects.toBe(authorityError);
    expect((await readdir(f.folder)).sort()).toEqual([
      'converter',
      'structure.cjs',
    ]);
  });
  it.each([
    { kind: 'UNVERIFIABLE', reason: 'BUDGET_EXCEEDED' },
    { kind: 'UNVERIFIABLE', reason: 'INVALID_STRUCTURE' },
  ])('preserves strict extractor failures', async (response) => {
    const f = await fixture({
      extractor: `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
    });
    expect(
      await f.runner.extractStructure({
        bytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual(response);
  });
  it.each([
    { kind: 'UNKNOWN', reason: 'INVALID_STRUCTURE' },
    { kind: 'UNVERIFIABLE', reason: 'STRUCTURE_DIFFERENT' },
    { kind: 'STRUCTURE', structure: { tables: [] } },
  ])('refuses malformed extractor envelopes', async (response) => {
    const f = await fixture({
      extractor: `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`,
    });
    expect(
      await f.runner.extractStructure({
        bytes: new Uint8Array([1]),
        maximumBytes: 1024,
        checkAuthority: async () => {
          await Promise.resolve();
        },
      }),
    ).toEqual({ kind: 'UNVERIFIABLE', reason: 'INVALID_STRUCTURE' });
  });
});
