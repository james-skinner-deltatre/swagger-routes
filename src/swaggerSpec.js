'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const util = require('./util')
const assert = require('assert')

const HTTP_METHODS = [
	'get',
	'put',
	'post',
	'delete',
	'options',
	'head',
	'patch'
]

const PARAM_GROUP = {
	HEADER: 'header',
	PATH: 'path',
	QUERY: 'query',
	BODY: 'body',
	FORM_DATA: 'formData'
}

const PARAM_GROUPS =
	Object.keys(PARAM_GROUP)
		.map(k => PARAM_GROUP[k])

exports.PARAM_GROUP = PARAM_GROUP
exports.PARAM_GROUPS = PARAM_GROUPS
exports.getSpec = getSpec
exports.getSpecSync = getSpecSync
exports.getAllOperations = getAllOperations
exports.createPathOperation = createPathOperation

function getSpec(spec) {
	if (typeof spec === 'string') {
		return loadSpec(spec).then(spec => applyDefaults(spec))
	} else {
		return Promise.resolve(applyDefaults(spec))
	}
}

function getSpecSync(spec) {
	if (typeof spec === 'string') {
		spec = loadSpecSync(spec)
	}
	return applyDefaults(spec)
}

function loadSpec(specPath) {
	return util.readFile(specPath)
		.then(contents => parseSpec(contents, specPath))
}

function loadSpecSync(specPath) {
	const contents = fs.readFileSync(specPath)
	return parseSpec(contents, specPath)
}

function parseSpec(contents, path) {
	return isYamlFile(path) ?
		yaml.safeLoad(contents) :
		JSON.parse(contents)
}

function isYamlFile(filePath) {
	return path.extname(filePath).match(/^\.ya?ml$/)
}

function applyDefaults(spec) {
	if (!spec.basePath) spec.basePath = '/'
	return spec
}

function getAllOperations(spec) {
	return getPaths(spec)
		.reduce((ops, pathInfo) =>
			ops.concat(getPathOperations(pathInfo, spec)), [])
}

function getPaths(spec) {
	return Object.keys(spec.paths || {})
		.map(path => Object.assign({ path }, spec.paths[path]))
}

function getPathOperations(pathInfo, spec) {
	const xProps = getXProps(pathInfo)
	return Object.keys(pathInfo)
		.filter(key => HTTP_METHODS.indexOf(key) !== -1)
		.map(method => createPathOperation(method, pathInfo, xProps, spec))
}

function getXProps(data) {
	return Object.keys(data)
		.filter(prop => prop.startsWith('x-'))
		.reduce((xProps, prop) => {
			xProps[prop] = data[prop]
			return xProps
		}, {})
}

function createPathOperation(method, pathInfo, pathsXProps, spec) {
	const operationInfo = resolveRefs(pathInfo[method], spec)
	if (!operationInfo.parameters) operationInfo.parameters = []
	if (!operationInfo.responses) operationInfo.responses = {}
	const operation = Object.assign({
		id: operationInfo.operationId,
		path: pathInfo.path,
		fullPath: path.normalize(`/${spec.basePath}/${pathInfo.path}`),
		consumes: getOperationProperty('consumes', operationInfo, spec),
		produces: getOperationProperty('produces', operationInfo, spec),
		paramGroupSchemas: createParamGroupSchemas(operationInfo.parameters, spec),
		responseSchemas: createResponseSchemas(operationInfo.responses, spec),
		method
	}, pathsXProps, operationInfo)
	delete operation.operationId
	return operation
}

const refCache = new Map()
const dataCache = new Set()

function resolveRefs(data, spec) {
	if (!data || dataCache.has(data)) return data

	if (Array.isArray(data)) {
		return data.map(item => resolveRefs(item, spec))
	} else if (typeof data === 'object') {
		if (data.$ref) {
			const resolved = resolveRef(data.$ref, spec)
			delete data.$ref
			data = Object.assign({}, resolved, data)
		}
		dataCache.add(data)

		for (let name in data) {
			data[name] = resolveRefs(data[name], spec)
		}
	}
	return data
}

function resolveRef(ref, spec) {
	//if (refCache.has(ref)) return refCache.get(ref)
	const parts = ref.split('/')

	assert.ok(parts.shift() === '#', `Only support JSON Schema $refs in format '#/path/to/ref'`)

	let value = spec
	while (parts.length) {
		value = value[parts.shift()]
		assert.ok(value, `Invalid schema reference: ${ref}`)
	}
	refCache.set(ref, value)
	return value
}

function getOperationProperty(prop, pathInfo, spec) {
	return (pathInfo && pathInfo[prop]) ? pathInfo[prop] : spec[prop]
}

function createParamGroupSchemas(parameters, spec) {
	return PARAM_GROUPS
		.map(loc => {
			const params = parameters.filter(param => param.in === loc)
			return { 'in': loc, schema: createParamsSchema(params, spec) }
		})
		.filter(param => Object.keys(param.schema.properties).length)
		.reduce((map, param) => {
			map[param.in] = param.schema
			return map
		}, {})
}

function createParamsSchema(params) {
	return {
		type: 'object',
		properties:	params.reduce((props, param) => {
			props[param.name] = param = Object.assign({}, param)
			return props
		}, {}),
		required: params
			.filter(param => param.required)
			.map(param => param.name)
	}
}

function createResponseSchemas(responses, spec) {
	return Object.keys(responses)
		.map(id => ({
			id,
			bodySchema: responses[id].schema,
			headersSchema: createResponseHeadersSchema(responses[id].headers, spec)
		}))
		.reduce((result, response) => {
			result[response.id] = response
			return result
		}, {})
}

function createResponseHeadersSchema(headers) {
	if (!headers) return undefined
	return {
		type: 'object',
		properties:	headers,
		required: Object.keys(headers)
			.filter(name => headers[name].required)
	}
}
