import { expect, test } from 'bun:test'
import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const root=resolve(import.meta.dir,'..')
const json=(path:string)=>JSON.parse(readFileSync(join(root,path),'utf8'))

test('root plugin and marketplace share a valid root-relative source with matching names and version',()=>{
  const plugin=json('.claude-plugin/plugin.json')
  expect(plugin.name).toBe('github')
  const marketplace=json('.claude-plugin/marketplace.json')
  expect(marketplace.name).toBe('github-claude-channel')
  expect(marketplace.owner).toEqual({name:'Esonhugh'})
  expect(marketplace.plugins).toHaveLength(1)
  const entry=marketplace.plugins[0]
  expect(entry.name).toBe(plugin.name)
  expect(entry.version).toBe(plugin.version)
  expect(entry.version).toBe('0.1.0')
  expect(plugin.version).toBe(json('package.json').version)
  expect(entry.description).toBe(plugin.description)
  // Local sources resolve from the marketplace root, not its .claude-plugin directory.
  expect(entry.source).toBe('./')
  const pluginRoot=realpathSync(resolve(root,entry.source))
  expect(pluginRoot).toBe(realpathSync(root))
  expect(existsSync(join(pluginRoot,'.claude-plugin/plugin.json'))).toBe(true)
  expect(existsSync(join(pluginRoot,'.mcp.json'))).toBe(true)
  expect(json('package.json').name).toBe('github-claude-channel')
})

test('github MCP key and current-session skills match the github plugin namespace',()=>{
  const mcp=json('.mcp.json')
  expect(Object.keys(mcp.mcpServers)).toEqual(['github'])
  expect(mcp.mcpServers.github.command).toBe('bun')
  expect(mcp.mcpServers.github.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/src/cli.ts','stdio'])
  for(const name of ['subscribe','unsubscribe','list']) {
    const skill=readFileSync(join(root,'skills',name,'SKILL.md'),'utf8')
    expect(skill).toContain('github MCP')
    expect(skill).not.toContain('github-claude-channel MCP')
    expect(skill).not.toMatch(/^context:\s*fork\s*$/m)
  }
})
