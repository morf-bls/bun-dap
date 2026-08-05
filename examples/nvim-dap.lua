-- nvim-dap configuration for bun-dap.
-- Requires: nvim-dap (https://github.com/mfussenegger/nvim-dap), bun.
--
-- Launch: open a .ts/.js file, set a breakpoint, `:lua require('dap').continue()`.
-- Attach: start the target with `bun --inspect` (or --inspect-wait), then use
-- the `bun_attach` configuration with the ws:// URL printed on its stderr.

local dap = require('dap')

dap.adapters.bun = {
  type = 'executable',
  command = 'bun',
  args = { 'run', '/Users/kretek/workspace/sources/bun-dap/src/cli.ts' },
}

dap.configurations.typescript = {
  {
    type = 'bun', request = 'launch', name = 'Launch Bun',
    program = '${file}', cwd = '${workspaceFolder}',
  },
  {
    type = 'bun',
    request = 'attach',  -- prerequisite: start the target with `bun --inspect-wait=127.0.0.1:6499/debugme`
    name = 'Attach to Bun',
    url = 'ws://127.0.0.1:6499/debugme',
  },
}
dap.configurations.javascript = dap.configurations.typescript
