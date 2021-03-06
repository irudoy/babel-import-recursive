import template from '@babel/template'
import _path from 'path'
import _fs from 'fs'

const wildcardRegex = /\/\*$/
const recursiveRegex = /\/\*\*$/
const buildRequire = template(`for (let key in IMPORTED) {
  DIR_IMPORT[key === 'default' ? IMPORTED_NAME : key] = IMPORTED[key]
}`)

const toCamelCase = name =>
  name.replace(/([-_.]\w)/g, (_, $1) => $1[1].toUpperCase())

const toSnakeCase = name =>
  name.replace(
    /([-.A-Z])/g,
    (_, $1) => `_${$1 === '.' || $1 === '-' ? '' : $1.toLowerCase()}`,
  )

const getFiles = (
  parent,
  exts = ['js', 'mjs', 'jsx'],
  nostrip = false,
  files = [],
  recursive = false,
  path = [],
) => {
  const r = _fs.readdirSync(parent)

  for (let i = 0, l = r.length; i < l; i++) {
    const child = r[i]

    const { name, ext } = _path.parse(child)
    const file = path.concat(nostrip ? child : name)

    // Check extension is of one of the aboves
    if (exts.includes(ext && ext.length ? ext.slice(1, ext.length) : ext)) {
      files.push(file)
    } else if (
      recursive &&
      _fs.statSync(_path.join(parent, child)).isDirectory()
    ) {
      getFiles(_path.join(parent, name), exts, nostrip, files, recursive, file)
    }
  }

  return files
}

export default function dir(babel) {
  const { types: t } = babel

  return {
    visitor: {
      ImportDeclaration(path, state) {
        const { node } = path
        const src = node.source.value

        if (src[0] !== '.' && src[0] !== '/') {
          return
        }
        const pathPrefix = `${src.split('/')[0]}/`
        const isAbsolute = src[0] === '/'

        const isExplicitWildcard = wildcardRegex.test(src)
        let cleanedPath = src.replace(wildcardRegex, '')

        const isRecursive = recursiveRegex.test(cleanedPath)
        cleanedPath = cleanedPath.replace(recursiveRegex, '')

        const sourcePath =
          this.file.opts.parserOpts.sourceFileName ||
          this.file.opts.parserOpts.filename ||
          ''
        const checkPath = _path.resolve(
          isAbsolute
            ? cleanedPath
            : _path.join(_path.dirname(sourcePath), cleanedPath),
        )

        try {
          require.resolve(checkPath)

          return
        } catch (e) {} // eslint-disable-line no-empty

        try {
          if (!_fs.statSync(checkPath).isDirectory()) {
            return
          }
        } catch (e) {
          return
        }

        const nameTransform = state.opts.snakeCase ? toSnakeCase : toCamelCase

        // eslint-disable-next-line no-underscore-dangle
        let _files = getFiles(
          checkPath,
          state.opts.exts,
          state.opts.nostrip,
          [],
          isRecursive,
        )

        if (typeof state.opts.listTransform === 'function') {
          _files = state.opts.listTransform(_files)
        }

        const files = _files.map(file => [
          file,
          nameTransform(file[file.length - 1]),
          path.scope.generateUidIdentifier(file[file.length - 1]),
        ])

        if (!files.length) {
          return
        }

        const imports = files.map(([file, , fileUid]) =>
          t.importDeclaration(
            node.specifiers.length ? [t.importNamespaceSpecifier(fileUid)] : [],
            t.stringLiteral(
              (sourcePath || isAbsolute ? '' : pathPrefix) +
                _path.join(cleanedPath, ...file),
            ),
          ),
        )

        const dirVar = path.scope.generateUidIdentifier('dirImport')
        if (node.specifiers.length) {
          path.insertBefore(
            t.variableDeclaration('const', [
              t.variableDeclarator(dirVar, t.objectExpression([])),
            ]),
          )
        }

        for (let i = node.specifiers.length - 1; i >= 0; i--) {
          const dec = node.specifiers[i]

          if (
            t.isImportNamespaceSpecifier(dec) ||
            t.isImportDefaultSpecifier(dec)
          ) {
            path.insertAfter(
              t.variableDeclaration('const', [
                t.variableDeclarator(t.identifier(dec.local.name), dirVar),
              ]),
            )
          }

          if (t.isImportSpecifier(dec)) {
            path.insertAfter(
              t.variableDeclaration('const', [
                t.variableDeclarator(
                  t.identifier(dec.local.name),
                  t.memberExpression(dirVar, t.identifier(dec.imported.name)),
                ),
              ]),
            )
          }
        }

        if (node.specifiers.length) {
          if (isExplicitWildcard) {
            files.forEach(([, fileName, fileUid]) =>
              path.insertAfter(
                buildRequire({
                  IMPORTED_NAME: t.stringLiteral(fileName),
                  DIR_IMPORT: dirVar,
                  IMPORTED: fileUid,
                }),
              ),
            )
          } else {
            files.forEach(([, fileName, fileUid]) =>
              path.insertAfter(
                t.assignmentExpression(
                  '=',
                  t.memberExpression(dirVar, t.identifier(fileName)),
                  fileUid,
                ),
              ),
            )
          }
        }

        path.replaceWithMultiple(imports)
      },
    },
  }
}
