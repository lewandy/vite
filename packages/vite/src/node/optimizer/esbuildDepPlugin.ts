import path from 'path'
import { Loader, Plugin } from 'esbuild'
import { knownAssetTypes } from '../constants'
import { ResolvedConfig } from '..'
import { isRunningWithYarnPnp, flattenId, normalizePath } from '../utils'
import { browserExternalId } from '../plugins/resolve'
import { ExportsData } from '.'

const externalTypes = [
  'css',
  // supported pre-processor types
  'less',
  'sass',
  'scss',
  'style',
  'stylus',
  'postcss',
  // known SFC types
  'vue',
  'svelte',
  ...knownAssetTypes
]

export function esbuildDepPlugin(
  qualified: Record<string, string>,
  exportsData: Record<string, ExportsData>,
  config: ResolvedConfig
): Plugin {
  const _resolve = config.createResolver({ asSrc: false })

  const resolve = (
    id: string,
    importer: string,
    resolveDir?: string
  ): Promise<string | undefined> => {
    let _importer
    // explicit resolveDir - this is passed only during yarn pnp resolve for
    // entries
    if (resolveDir) {
      _importer = normalizePath(path.join(resolveDir, '*'))
    } else {
      // map importer ids to file paths for correct resolution
      _importer = importer in qualified ? qualified[importer] : importer
    }
    return _resolve(id, _importer)
  }

  return {
    name: 'vite:dep-pre-bundle',
    setup(build) {
      // externalize assets and commonly known non-js file types
      build.onResolve(
        {
          filter: new RegExp(`\\.(` + externalTypes.join('|') + `)(\\?.*)?$`)
        },
        async ({ path: id, importer }) => {
          const resolved = await resolve(id, importer)
          if (resolved) {
            return {
              path: resolved,
              external: true
            }
          }
        }
      )

      function resolveEntry(id: string, isEntry: boolean) {
        const flatId = flattenId(id)
        if (flatId in qualified) {
          return isEntry
            ? {
                path: flatId,
                namespace: 'dep'
              }
            : {
                path: path.resolve(qualified[flatId])
              }
        }
      }

      build.onResolve(
        { filter: /^[\w@][^:]/ },
        async ({ path: id, importer }) => {
          const isEntry = !importer
          // ensure esbuild uses our resolved entires
          let entry
          // if this is an entry, return entry namespace resolve result
          if ((entry = resolveEntry(id, isEntry))) return entry

          // check if this is aliased to an entry - also return entry namespace
          const aliased = await _resolve(id, undefined, true)
          if (aliased && (entry = resolveEntry(aliased, isEntry))) {
            return entry
          }

          // use vite resolver
          const resolved = await resolve(id, importer)
          if (resolved) {
            if (resolved.startsWith(browserExternalId)) {
              return {
                path: id,
                namespace: 'browser-external'
              }
            }
            return {
              path: path.resolve(resolved)
            }
          }
        }
      )

      // For entry files, we'll read it ourselves and construct a proxy module
      // to retain the entry's raw id instead of file path so that esbuild
      // outputs desired output file structure.
      // It is necessary to do the re-exporting to separate the virtual proxy
      // module from the actual module since the actual module may get
      // referenced via relative imports - if we don't separate the proxy and
      // the actual module, esbuild will create duplicated copies of the same
      // module!
      const root = path.resolve(config.root)
      build.onLoad({ filter: /.*/, namespace: 'dep' }, ({ path: id }) => {
        const entryFile = qualified[id]

        let relativePath = normalizePath(path.relative(root, entryFile))
        if (!relativePath.startsWith('.')) {
          relativePath = `./${relativePath}`
        }

        let contents = ''
        const [imports, exports] = exportsData[id]
        if (!imports.length && !exports.length) {
          // cjs
          contents += `import d from "${relativePath}";export default d;`
        } else {
          if (exports.includes('default')) {
            contents += `import d from "${relativePath}";export default d;`
          }
          if (exports.length > 1 || exports[0] !== 'default') {
            contents += `\nexport * from "${relativePath}"`
          }
        }

        let ext = path.extname(entryFile).slice(1)
        if (ext === 'mjs') ext = 'js'
        return {
          loader: ext as Loader,
          contents,
          resolveDir: isRunningWithYarnPnp ? undefined : root
        }
      })

      build.onLoad(
        { filter: /.*/, namespace: 'browser-external' },
        ({ path: id }) => {
          return {
            contents:
              `export default new Proxy({}, {
  get() {
    throw new Error('Module "${id}" has been externalized for ` +
              `browser compatibility and cannot be accessed in client code.')
  }
})`
          }
        }
      )

      // yarn 2 pnp compat
      if (isRunningWithYarnPnp) {
        build.onResolve(
          { filter: /.*/ },
          async ({ path, importer, resolveDir }) => ({
            // pass along resolveDir for entries
            path: await resolve(path, importer, resolveDir)
          })
        )
        build.onLoad({ filter: /.*/ }, async (args) => ({
          contents: await require('fs').promises.readFile(args.path),
          loader: 'default'
        }))
      }
    }
  }
}
