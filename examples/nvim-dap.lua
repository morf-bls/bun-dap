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

-- Point args at your checkout of bun-dap instead of the absolute path above.
dap.configurations.typescript = {
  {
    type = 'bun',
    request = 'launch',
    name = 'Debug Bun (launch)',
    program = '${file}',
    cwd = '${workspaceFolder}',
    runtime = 'bun',
    stopOnEntry = false,
    noDebug = false,
  },
}
dap.configurations.javascript = dap.configurations.typescript

-- Attach: `bun --inspect=127.0.0.1:6499 path/to/app.ts`, copy the ws:// URL
-- printed on stderr into `url` (or set it from the terminal output directly).
dap.adapters.bun_attach = {
  type = 'executable',
  command = 'bun',
  args = { 'run', '/Users/kretek/workspace/sources/bun-dap/src/cli.ts' },
}
dap.configurations.bun_attach = {
  {
    type = 'bun_attach',
    request = 'attach',
    name = 'Attach to Bun',
    url = 'ws://127.0.0.1:6499/<uuid>',
  },
}
