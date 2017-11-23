import Tracer from "datadog-tracer"
import { forIn, has } from "lodash"
import { timestamp } from "./helpers"
import { getNamedType, GraphQLObjectType } from "graphql"
import * as introspectionQuery from "graphql/type/introspection"

function parse_args() {
  return "( ... )"
}

function drop_params(query) {
  return query.replace(/(\()([^\)]*)(\))/g, parse_args)
}

function pushFinishedSpan(finishedSpans, span) {
  const endTime = timestamp()
  finishedSpans.push({ span, endTime })
}

function processFinishedSpans(finishedSpans) {
  let i = 0
  const iter = () => {
    const entry = finishedSpans[i]
    if (entry) {
      const { span, endTime } = entry
      span.finish(endTime)
      i++
      setImmediate(iter)
    }
  }
  setImmediate(iter)
}

function trace(res, span) {
  span.addTags({
    "http.status_code": res.statusCode,
  })
  const { finishedSpans } = res.locals
  pushFinishedSpan(finishedSpans, span)
  processFinishedSpans(finishedSpans)
}

function wrapResolve(typeName, fieldName, resolver) {
  return function wrappedResolver(_root, _opts, _req, { rootValue }) {
    const parentSpan = rootValue.span
    const span = parentSpan
      .tracer()
      .startSpan("metaphysics.resolver." + typeName + "." + fieldName, { childOf: parentSpan.context() })
    span.addTags({
      resource: typeName + ": " + fieldName,
      type: "web",
      "span.kind": "server",
    })

    // Set the parent context to this span for any sub resolvers.
    rootValue.span = span // eslint-disable-line no-param-reassign

    const result = resolver.apply(this, arguments)

    // Return parent context to our parent for any resolvers called after this one.
    rootValue.span = parentSpan // eslint-disable-line no-param-reassign

    if (result instanceof Promise) {
      return result.finally(() => pushFinishedSpan(rootValue.finishedSpans, span))
    }

    pushFinishedSpan(rootValue.finishedSpans, span)
    return result
  }
}

export function makeSchemaTraceable(schema) {
  // Walk the schema and for all object type fields with resolvers wrap them in our tracing resolver.
  forIn(schema._typeMap, (type, typeName) => {
    if (!introspectionQuery[type] && has(type, "_fields")) {
      forIn(type._fields, (field, fieldName) => {
        if (field.resolve instanceof Function && getNamedType(field.type) instanceof GraphQLObjectType) {
          field.resolve = wrapResolve(typeName, fieldName, field.resolve) // eslint-disable-line no-param-reassign
        }
      })
    }
  })
}

export function middleware(req, res, next) {
  const tracer = new Tracer({ service: "metaphysics" })
  const span = tracer.startSpan("metaphysics.query")
  span.addTags({
    type: "web",
    "span.kind": "server",
    "http.method": req.method,
    "http.url": req.url,
  })

  if (req.body && req.body.query) {
    const query = drop_params(req.body.query)
    span.addTags({ resource: query })
  } else {
    span.addTags({ resource: req.path })
  }

  res.locals.span = span // eslint-disable-line no-param-reassign
  res.locals.finishedSpans = [] // eslint-disable-line no-param-reassign

  const finish = trace.bind(null, res, span)
  res.on("finish", finish)
  res.on("close", finish)

  next()
}