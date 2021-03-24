"use strict";

const _ 					= require("lodash");
const BaseTraceExporter 	= require("./base");
const { isFunction } 		= require("../../utils");

/*
	docker run -d --name dd-agent --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock:ro -v /proc/:/host/proc/:ro -v /sys/fs/cgroup/:/host/sys/fs/cgroup:ro -e DD_API_KEY=123456 -e DD_APM_ENABLED=true -e DD_APM_NON_LOCAL_TRAFFIC=true -p 8126:8126  datadog/agent:latest
*/

let DatadogSpanContext;
let DatadogID;
let Reference;

/**
 * Datadog Trace Exporter with 'dd-trace'.
 *
 * @class DatadogTraceExporter
 */
class DatadogTraceExporter extends BaseTraceExporter {

	/**
	 * Creates an instance of DatadogTraceExporter.
	 * @param {Object?} opts
	 * @memberof DatadogTraceExporter
	 */
	constructor(opts) {
		super(opts);

		this.opts = _.defaultsDeep(this.opts, {
			agentUrl: process.env.DD_AGENT_URL || "http://localhost:8126",
			env: process.env.DD_ENVIRONMENT || null,
			samplingPriority: "AUTO_KEEP",
			defaultTags: null,
			tracerOptions: null,
		});

		this.ddTracer = this.opts.tracer;
	}

	/**
	 * Initialize Trace Exporter.
	 *
	 * @param {Tracer} tracer
	 * @memberof DatadogTraceExporter
	 */
	init(tracer) {
		super.init(tracer);

		try {
			const ddTrace = require("dd-trace");
			DatadogSpanContext = require("dd-trace/packages/dd-trace/src/opentracing/span_context");
			DatadogID = require("dd-trace/packages/dd-trace/src/id");
			Reference = require("opentracing").Reference;
			if (!this.ddTracer) {
				this.ddTracer = ddTrace.init(_.defaultsDeep(this.opts.tracerOptions, {
					url: this.opts.agentUrl
				}));
			}
		} catch(err) {
			/* istanbul ignore next */
			this.tracer.broker.fatal("The 'dd-trace' package is missing! Please install it with 'npm install dd-trace --save' command!", err, true);
		}

		this.defaultTags = isFunction(this.opts.defaultTags) ? this.opts.defaultTags.call(this, tracer) : this.opts.defaultTags;
		if (this.defaultTags) {
			this.defaultTags = this.flattenTags(this.defaultTags, true);
		}

		this.ddScope = this.ddTracer.scope();

		// dd-trace-js defaults to AsyncLocalStorage for node >=14.5 || ^12.19.0, but the old implementation can be forced with the `scope: "async_hooks"` init option
		this.usesAsyncLocalStorage = this.ddScope._storage !== undefined;

		const oldGetCurrentTraceID = this.tracer.getCurrentTraceID.bind(this.tracer);
		this.tracer.getCurrentTraceID = () => {
			const traceID = oldGetCurrentTraceID();
			if (traceID)
				return traceID;

			if (this.ddScope) {
				const span = this.ddScope.active();
				if (span) {
					const spanContext = span.context();
					if (spanContext)
						return spanContext.toTraceId();
				}
			}
			return null;
		};

		const oldGetActiveSpanID = this.tracer.getActiveSpanID.bind(this.tracer);
		this.tracer.getActiveSpanID = () => {
			const spanID = oldGetActiveSpanID();
			if (spanID)
				return spanID;

			if (this.ddScope) {
				const span = this.ddScope.active();
				if (span) {
					const spanContext = span.context();
					if (spanContext)
						return spanContext.toSpanId();
				}
			}
			return null;
		};
	}

	/**
	 * Stop Trace exporter
	 */
	stop() {
		return this.broker.Promise.resolve();
	}

	/**
	 * Span is started.
	 *
	 * @param {Span} span
	 * @memberof BaseTraceExporter
	 */
	spanStarted(span) {
		if (!this.ddTracer) return null;

		const serviceName = span.service ? span.service.fullName : null;

		let reference;
		if (span.parentID) {
			const parentCtx = new DatadogSpanContext({
				traceId: this.convertID(span.traceID),
				spanId: this.convertID(span.parentID),
				parentId: this.convertID(span.parentID)
			});
			reference = new Reference(span.type === "event" ? "follows_from" : "child_of", parentCtx);
		}

		const ddSpan = this.ddTracer.startSpan(span.name, {
			startTime: span.startTime,
			references: reference ? [reference] : [],
			tags: this.flattenTags(_.defaultsDeep({}, span.tags, {
				span: {
					kind: "server",
					type: span.type,
				},
				type: span.type,
				resource: span.tags.action ? span.tags.action.name : undefined,
				"sampling.priority": this.opts.samplingPriority
			}, this.defaultTags))
		});

		if (this.opts.env)
			this.addTags(ddSpan, "env", this.opts.env);
		this.addTags(ddSpan, "service.name", serviceName);

		const sc = ddSpan.context();
		sc._traceId = this.convertID(span.traceID);
		sc._spanId = this.convertID(span.id);

		// Save current active span to restore later
		const oldSpan = this.ddScope.active();

		// Activate new span in Datadog tracer
		if (this.usesAsyncLocalStorage) {
			this.ddScope._storage.enterWith(ddSpan);
		} else {
			this.ddScope._enter(ddSpan);
		}

		span.meta.datadog = {
			span: ddSpan,
			oldSpan
		};
	}

	/**
	 * Span is finished.
	 *
	 * @param {Span} span
	 * @memberof DatadogTraceExporter
	 */
	spanFinished(span) {
		if (!this.ddTracer) return null;

		const item = span.meta.datadog;
		if (!item) return null;

		const ddSpan = item.span;

		if (span.error) {
			this.addTags(ddSpan, "error", this.errorToObject(span.error));
		}

		this.addLogs(ddSpan, span.logs);

		ddSpan.finish(span.finishTime);

		// Restore previous active span
		if (this.usesAsyncLocalStorage) {
			this.ddScope._storage.enterWith(item.oldSpan || null);
		} else {
			this.ddScope._exit(item.oldSpan || null);
		}
	}

	/**
	 * Activate the current span inside `dd-trace` library.
	 *
	 * @param {DatadogSpan} span
	 * @param {Promise} promise
	 * @returns {Promise}
	 *
	 * @memberof DatadogTraceExporter
	 *
	activatePromise(span, promise) {
		const asyncId = asyncHooks.executionAsyncId();
		const oldSpan = this.ddScope._spans[asyncId];

		this.ddScope._spans[asyncId] = span;

		const finish = (err, data) => {
			if (oldSpan) {
				this.ddScope._spans[asyncId] = oldSpan;
			} else {
				this.ddScope._destroy(asyncId);
			}
			if (err) {
				if (span && typeof span.addTags === "function") {
					span.addTags({
						"error.type": err.name,
						"error.msg": err.message,
						"error.stack": err.stack
					});
				}
				throw err;
			}
			return data;
		};

		return promise
			.then(res => finish(null, res))
			.catch(err => finish(err));
	}
	*/

	/**
	 * Add tags to span
	 *
	 * @param {Object} span
	 * @param {String} key
	 * @param {any} value
	 * @param {String?} prefix
	 */
	addTags(span, key, value, prefix) {
		const name = prefix ? `${prefix}.${key}` : key;
		if (value != null && typeof value == "object") {
			Object.keys(value).forEach(k => this.addTags(span, k, value[k], name));
		} else if (value !== undefined) {
			span.setTag(name, value);
		}
	}

	/**
	 * Add logs to span
	 *
	 * @param {Object} span
	 * @param {Array} logs
	 */
	addLogs(span, logs) {
		if (Array.isArray(logs)) {
			logs.forEach((log) => {
				span.log({
					event: log.name,
					payload: log.fields,
				}, log.time);
			});
		}
	}


	/**
	 * Convert Trace/Span ID to Jaeger format
	 *
	 * @param {String} id
	 * @returns {String}
	 */
	convertID(id) {
		if (id) {
			if (id.indexOf("-") !== -1)
				return DatadogID(id.replace(/-/g, "").substring(0,16));
			return DatadogID(id);
		}

		return null;
	}
}

module.exports = DatadogTraceExporter;
