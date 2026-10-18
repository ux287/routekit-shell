import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { globSync } from 'glob';

function ensureDir(p: string){ fs.mkdirSync(p,{ recursive: true }); }

function fmEnsureRagAndProjectTag(txt: string, slug: string){
  return txt.replace(/^---\n([\s\S]*?)\n---/m,(fm)=>{
    let block=fm;
    const hasRag=/^\s*rag\s*:/m.test(block);
    const isPrivate=/^\s*private\s*:\s*true/m.test(block);
    if(!hasRag && !isPrivate) block=block.replace(/^---\n/,'---\nrag: true\n');
    if(!/^\s*tags\s*:/m.test(block)){
      block=block.replace(/^---\n/, `---\ntags: ["project:${slug}"]\n`);
    } else if(!new RegExp(`project:${slug}`).test(block)){
      block=block.replace(/tags:\s*\[([^\]]*)\]/,(m,g)=>`tags: [${g}${g.trim()? ', ' : ''}"project:${slug}"]`);
    }
    return block;
  });
}

export const notesSeed = new Command('seed')
  .description('Seed docs/design notes from routekit-shell vault into a project and rewrite slugs')
  .requiredOption('--toVault <abs>', 'absolute path to destination notes dir (e.g., ./notes)')
  .requiredOption('--toSlug <slug>', 'project slug (e.g., acme-site)')
  .option('--domains <csv>', 'domains to include (default: design,docs)', 'design,docs')
  .action(async (opts) => {
    const fromVault = path.resolve(process.cwd(), 'notes'); // shell vault
    if(!fs.existsSync(fromVault)){
      console.error(`Shell vault not found: ${fromVault}`);
      process.exit(2);
    }
    const toVault = path.resolve(opts.toVault);
    const toSlug  = String(opts.toSlug);
    const domains = String(opts.domains).split(',').map(s=>s.trim()).filter(Boolean);

    ensureDir(toVault);

    let copied=0;
    for(const d of domains){
      const pat = path.join(fromVault, `routekit-shell.${d}.*.md`);
      for(const src of globSync(pat,{ nodir:true })){
        const outName = path.basename(src).replace('routekit-shell', toSlug);
        const dest = path.join(toVault, outName);
        let txt = fs.readFileSync(src,'utf8')
          .replaceAll('routekit-shell', toSlug)
          .replaceAll('ROUTEKIT SHELL', toSlug.toUpperCase());
        txt = fmEnsureRagAndProjectTag(txt, toSlug);
        fs.writeFileSync(dest, txt);
        copied++;
      }
    }
    console.log(JSON.stringify({ ok:true, fromVault, toVault, toSlug, domains, copied }, null, 2));
  });
