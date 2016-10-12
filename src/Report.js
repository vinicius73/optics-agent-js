// This file contains the functions for processing incoming data from
// the agent instrumentation and reporting it back to the optics
// backend.


import request from 'request';
import { graphql } from 'graphql';
import { visit, visitWithTypeInfo, print } from 'graphql/language';
import {
  getNamedType,
  GraphQLObjectType,
} from 'graphql/type';
import { TypeInfo } from 'graphql/utilities';


import {
  printType,
  latencyBucket, newLatencyBuckets, addLatencyToBuckets, trimLatencyBuckets
} from './Normalize';

import {
  Timestamp, Trace, ReportHeader,
  TracesReport, StatsReport, SchemaReport,
  StatsPerSignature, StatsPerClientName,
  FieldStat, TypeStat, Field, Type
} from './Proto';

var VERSION = "optics-agent-js " + require('../package.json').version;

var os = require('os');


//////////////////// Incoming Data ////////////////////

// Called once per resolver function execution.
export const reportResolver = (context, info, {typeName, fieldName}, nanos) => {
  const agent = context.agent;
  const query = agent.normalizeQuery(info);
  const res = agent.pendingResults;

  const fObj = res &&
          res[query] &&
          res[query].perField &&
          res[query].perField[typeName] &&
          res[query].perField[typeName][fieldName];
  if (!fObj) {
    // This happens when a report is sent while a query is running.
    // When this happens, we do not record the rest of the query's resolvers.
    // See: https://github.com/apollostack/optics-agent-js/issues/4
    return;
  }
  addLatencyToBuckets(fObj.latencyBuckets, nanos);
};


// Called once per query at query start time by graphql-js.
export const reportRequestStart = (context) => {
  const req = context.req;
  if (!context || !context.info || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }
  const info = context.info;
  const agent = context.agent;

  try {
    const query = agent.normalizeQuery(info);
    const { client_name, client_version } = agent.normalizeVersion(req);

    const res = agent.pendingResults;


    // Initialize per-query state in the report if we're the first of
    // this query shape to come in this report period.
    if (!res[query]) {
      res[query] = {
        perClient: {},
        perField: {}
      };
    }

    // fill out per field if we haven't already for this query shape.
    // XXX move into if statement above?
    const perField = res[query].perField;
    if (Object.keys(perField).length == 0) {
      const typeInfo = new TypeInfo(agent.schema);
      visit(info.operation, visitWithTypeInfo(typeInfo, {
        Field: () => {
          const parentType = typeInfo.getParentType().name;
          if (!perField[parentType]) {
            perField[parentType] = {};
          }
          const fieldName = typeInfo.getFieldDef().name;
          perField[parentType][fieldName] = {
            returnType: printType(typeInfo.getType()),
            latencyBuckets: newLatencyBuckets()
          };
        }
      }));
    }

    // initialize latency buckets if this is the first time we've had
    // a query from this client type in this period.
    const perClient = res[query].perClient;
    if (!perClient[client_name]) {
      perClient[client_name] = {
        latencyBuckets: newLatencyBuckets(),
        perVersion: {}
      };
    }
  } catch (e) {
    // XXX https://github.com/apollostack/optics-agent-js/issues/17
    console.log("EEE", e);
  }
};

// called once per query by the middleware when the request ends.
export const reportRequestEnd = (req) => {
  const context = req._opticsContext;
  if (!context || !context.info || !context.agent) {
    // Happens when non-graphql requests come through.
    return;
  }
  const info = context.info;
  const agent = context.agent;

  try {
    const query = agent.normalizeQuery(info);
    const { client_name, client_version } = agent.normalizeVersion(req);
    const res = agent.pendingResults;

    let clientObj = (
      res[query] && res[query].perClient && res[query].perClient[client_name]);

    // XXX XXX are we double counting? straighten out what happens to
    // queries over the request boundary.
    // Related: https://github.com/apollostack/optics-agent-js/issues/16
    //
    // This happens when the report was sent while the query was
    // running. If that happens, just re-init the structure by
    // re-reporting.
    reportRequestStart(context);

    // should be fixed now.
    clientObj = (
      res[query] && res[query].perClient && res[query].perClient[client_name]);

    if (!clientObj) {
      // XXX huh?
      console.log("CC2", query);
      return;
    }

    const nanos = (context.durationHrTime[0]*1e9 +
                   context.durationHrTime[1]);

    // check to see if we've sent a trace for this bucket yet this
    // report period. if we haven't, send one now.
    const bucket = latencyBucket(nanos);
    const numSoFar = clientObj.latencyBuckets[bucket];
    if (0 == numSoFar && agent.reportTraces) {
      reportTrace(agent, context);
    }

    addLatencyToBuckets(clientObj.latencyBuckets, nanos);

    const perVersion = clientObj.perVersion;
    if (!perVersion[client_version]) {
      perVersion[client_version] = 0;
    }
    perVersion[client_version] += 1;

  } catch (e) {
    // XXX https://github.com/apollostack/optics-agent-js/issues/17
    console.log("EEE", e);
  }

};

export const reportTrace = (agent, context) => {
  // For now just send every trace immediately. We might want to add
  // batching here at some point.
  //
  // Send in its own function on the event loop to minimize impact on
  // response times.
  setImmediate(() => sendTrace(agent, context));
};

export const reportSchema = (agent, schema) => {
  // Sent once on startup. Wait 10 seconds to report the schema. This
  // does two things:
  // - help apps start up and serve users faster. don't clog startup
  //   time with reporting.
  // - avoid sending a ton of reports from a crash-looping server.
  setTimeout(() => sendSchema(agent, schema), 10*1000);
};



//////////////////// Marshalling Data ////////////////////

export const sendReport = (agent, reportData, startTime, endTime, durationHr) => {
  try {
    // build report protobuf object
    const report = new StatsReport();
    report.header = new ReportHeader({
      hostname: os.hostname(),
      agent_version: VERSION,
      runtime_version: "node " + process.version,
      // XXX not actually uname, but what node has easily.
      uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`
    });

    report.start_time = new Timestamp(
      { seconds: (endTime / 1000), nanos: (endTime % 1000)*1e6 });
    report.end_time = new Timestamp(
      { seconds: (startTime / 1000), nanos: (startTime % 1000)*1e6 });
    report.realtime_duration = durationHr[0]*1e9 + durationHr[1];

    report.type = getTypesFromSchema(agent.schema);

    // fill out per signature
    report.per_signature = {};
    Object.keys(reportData).forEach((query) => {
      const c = new StatsPerSignature;

      // add client stats
      c.per_client_name = {};
      const clients = reportData[query].perClient;
      Object.keys(clients).forEach((client) => {
        const versions = clients[client].perVersion;
        const v = new StatsPerClientName;
        v.latency_count = trimLatencyBuckets(clients[client].latencyBuckets);
        v.count_per_version = {};
        Object.keys(versions).forEach((version) => {
          const r = versions[version];
          v.count_per_version[version] = r;
        });
        c.per_client_name[client] = v;
      });

      // add field stats
      c.per_type = [];
      const fields = reportData[query].perField;
      Object.keys(fields).forEach((parentType) => {
        const ts = new TypeStat;
        c.per_type.push(ts);
        ts.name = parentType;
        ts.field = [];
        Object.keys(fields[parentType]).forEach((fieldName) => {
          const fs = new FieldStat;
          ts.field.push(fs);
          const fObj = fields[parentType][fieldName];
          fs.name = fieldName;
          fs.returnType = fObj.returnType;
          fs.latency_count = trimLatencyBuckets(fObj.latencyBuckets);
        });
      });

      report.per_signature[query] = c;
    });

    sendMessage(agent, '/api/ss/stats', report);
  } catch (e) {
    console.log("EEE", e);
  }
};


export const sendTrace = (agent, context) => {
  // exceptions from here are caught and ignored somewhere.
  // catch manually for debugging.
  try {
    const report = new TracesReport();
    report.header = new ReportHeader({
      hostname: os.hostname(),
      agent_version: VERSION,
      runtime_version: "node " + process.version,
      // XXX not actually uname, but what node has easily.
      uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`
    });
    const req = context.req;
    const info = context.info;

    const trace = new Trace();
    // XXX make up a server_id
    trace.start_time = new Timestamp(
      { seconds: (context.startWallTime / 1000),
        nanos: (context.startWallTime % 1000)*1e6 });
    trace.end_time = new Timestamp(
      { seconds: (context.endWallTime / 1000),
        nanos: (context.endWallTime % 1000)*1e6 });
    trace.duration_ns = context.durationHrTime[0]*1e9 + context.durationHrTime[1];

    trace.signature = agent.normalizeQuery(info);

    trace.details = new Trace.Details();
    const operationStr = print(info.operation);
    const fragmentsStr = Object.keys(info.fragments).map(k => print(info.fragments[k])).join('\n');
    trace.details.raw_query = `${operationStr}\n${fragmentsStr}`;
    if (info.operation.name) {
      trace.details.operation_name = print(info.operation.name);
    }
    if (agent.reportVariables) {
      trace.details.variables = {};
      for (let k of Object.keys(info.variableValues)) {
        trace.details.variables[k] = JSON.stringify(info.variableValues[k]);
      }
    }

    const { client_name, client_version } = agent.normalizeVersion(req);
    trace.client_name = client_name;
    trace.client_version = client_version;

    trace.client_addr = req.connection.remoteAddress; // XXX x-forwarded-for?
    trace.http = new Trace.HTTPInfo();
    trace.http.host = req.headers.host;
    trace.http.path = req.url;

    trace.execute = new Trace.Node();
    trace.execute.child = context.resolverCalls.map((rep) => {
      const n = new Trace.Node();
      n.field_name = rep.info.typeName + "." + rep.info.fieldName;
      n.start_time = rep.startOffset[0]*1e9 + rep.startOffset[1];
      n.end_time = rep.endOffset[0]*1e9 + rep.endOffset[1];
      // XXX
      return n;
    });

    // no batching for now.
    report.trace = [trace];

    sendMessage(agent, '/api/ss/traces', report);

  } catch (e) {
    console.log("EEE", e);
  }
};

export const sendSchema = (agent, schema) => {

  // modified introspection query that doesn't return something
  // quite so giant.
  const q = `
  query ShorterIntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        ...FullType
      }
      directives {
        name
        # description
        locations
        args {
          ...InputValue
        }
      }
    }
  }

  fragment FullType on __Type {
    kind
    name
    # description
    fields(includeDeprecated: true) {
      name
      # description
      args {
        ...InputValue
      }
      type {
        ...TypeRef
      }
      isDeprecated
      # deprecationReason
    }
    inputFields {
      ...InputValue
    }
    interfaces {
      ...TypeRef
    }
    enumValues(includeDeprecated: true) {
      name
      # description
      isDeprecated
      # deprecationReason
    }
    possibleTypes {
      ...TypeRef
    }
  }

  fragment InputValue on __InputValue {
    name
    # description
    type { ...TypeRef }
    # defaultValue
  }

  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                }
              }
            }
          }
        }
      }
    }
  }

`;
  graphql(schema, q).then(
    (res) => {
      if (!res || !res.data || !res.data.__schema) {
        // XXX huh?
        console.log("Bad schema result");
        return;
      }
      const resultSchema = res.data.__schema;
      // remove the schema schema from the schema.
      resultSchema.types = resultSchema.types.filter(
        (x) => x && (x.kind != 'OBJECT' || x.name != "__Schema")
      );

      const schemaString = JSON.stringify(resultSchema);

      const report = new SchemaReport();
      report.header = new ReportHeader({
        hostname: os.hostname(),
        agent_version: VERSION,
        runtime_version: "node " + process.version,
        // XXX not actually uname, but what node has easily.
        uname: `${os.platform()}, ${os.type()}, ${os.release()}, ${os.arch()})`
      });
      report.introspection_result = schemaString;
      report.type = getTypesFromSchema(schema);

      sendMessage(agent, '/api/ss/schema', report);
    }
  );
  // ).catch(() => {}); // XXX!
};

//////////////////// Sending Data ////////////////////

export const sendMessage = (agent, path, message) => {
  const headers = {
      'user-agent': "optics-agent-js"
  };
  if (agent.apiKey) {
    headers['x-api-key'] = agent.apiKey;
  }

  const options = {
    url: agent.endpointUrl + path,
    method: 'POST',
    headers,
    body: message.encode().toBuffer()
  };
  request(options, (err, res, body) => {
    // XXX add retry logic
    // XXX add separate flag for disable printing errors?
    if (err) {
      console.log('Error trying to report to optics backend:', err.message);
    } else if (res.statusCode < 200 || res.statusCode > 299) {
      console.log('Backend error', res.statusCode, body);
    }
  });

  if (agent.printReports) {
    console.log("OPTICS", path, message.encodeJSON());
  }
};

//////////////////// Helpers ////////////////////

export const getTypesFromSchema = (schema) => {
  const ret = [];
  const typeMap = schema.getTypeMap();
  const typeNames = Object.keys(typeMap);
  typeNames.forEach((typeName) => {
    const type = typeMap[typeName];
    if ( getNamedType(type).name.startsWith('__') ||
         ! (type instanceof GraphQLObjectType )) {
           return;
         }
    const t = new Type();
    t.name = typeName;
    t.field = [];
    const fields = type.getFields();
    Object.keys(fields).forEach((fieldName) => {
      const field = fields[fieldName];
      const f = new Field();
      f.name = fieldName;
      f.returnType = printType(field.type);
      t.field.push(f);
    });
    // XXX fields
    ret.push(t);
  });
  return ret;
};
