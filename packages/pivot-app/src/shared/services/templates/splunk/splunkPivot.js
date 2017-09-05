import _ from 'underscore';
import { Observable } from 'rxjs';
import moment from 'moment-timezone';
import logger from '../../../../shared/logger.js';
const log = logger.createLogger(__filename);


import { PivotTemplate } from '../template.js';
import { splunkConnector0 } from '../../connectors';
import { shapeResults } from '../../shapeResults.js';
import { splunkFieldsBlacklist, splunkEntitiesBlacklist, splunkAttributesBlacklist } from './settings.js';

export class SplunkPivot extends PivotTemplate {
    constructor( pivotDescription ) {
        super(pivotDescription);

        const { toSplunk, connections, encodings, attributes, connectionsBlacklist, attributesBlacklist } = pivotDescription;
        this.toSplunk = toSplunk;
        this.connections = connections;
        this.connectionsBlacklist = connectionsBlacklist || splunkEntitiesBlacklist;
        this.encodings = encodings;
        this.attributes = attributes;
        this.attributesBlacklist = attributesBlacklist || splunkAttributesBlacklist;
        this.connector = splunkConnector0;
    }

    searchAndShape({ app, pivot, pivotCache, time }) {

        const args = this.stripTemplateNamespace(pivot.pivotParameters);
        const {searchQuery, searchParams} = this.toSplunk(args, pivotCache, { time });
        log.trace({pivotParameters: pivot.pivotParameters, args}, 'Pivot parameters');
        pivot.template = this;

        if (!pivot.enabled) {
            pivot.resultSummary = {};
            pivot.resultCount = 0;
            return Observable.of({ app, pivot });
        } else {

            return this.connector.search(searchQuery, searchParams)
                .do(({ resultCount, events, searchId, df, isPartial }) => {
                    pivot.df = df;
                    pivot.resultCount = resultCount;
                    pivot.events = events;
                    pivot.splunkSearchId = searchId;
                    pivot.isPartial = isPartial;
                    pivot.connections = this.connections;
                    pivot.connectionsBlacklist = 
                        this.connections && this.connections.length ? [] : this.connectionsBlacklist;
                    pivot.attributes = this.attributes;
                    pivot.attributesBlacklist = 
                        this.attributes && this.attributes.length ? [] : this.attributesBlacklist;
                })
                .map(() => shapeResults({app, pivot}))
                .do(({pivot: pivotShaped}) => {
                    pivotCache[pivot.id] = {
                        results: pivotShaped.results,
                        query: searchQuery,
                        splunkSearchId: pivot.splunkSearchId
                    };
                    pivot.results = pivotShaped.results;
                });
        }
    }

    //{ from: ?{ date: ?moment.json, time: ?moment.json, timezone: ?moment.json }, 
    //  to: ?{ date: ?moment.json, time: ?moment.json, timezone: moment.json } }
    // * { from: ?{ date: ?moment.json, time: ?moment.json, timezone: ?moment.json }, 
    //  to: ?{ date: ?moment.json, time: ?moment.json, timezone: moment.json } }
    // -> ?{ earliest_time: ISO8601 str, latest_time: ISO8601 str }
    // time received in utc
    // ISO8601 as YYYY-MM-DDTHH:mm:ssZ
    dayRangeToSplunkParams(maybePivotTime, maybeGlobalTime) {      

        const pivotTime = {
            from: (maybePivotTime||{}).from || {}, 
            to: (maybePivotTime||{}).to || {}
        };
        const globalTime = {
            from: (maybeGlobalTime||{}).from || {}, 
            to: (maybeGlobalTime||{}).to || {}
        };

        const mergedTime = {
            from: {                
                date: pivotTime.from.date || globalTime.from.date,
                time: pivotTime.from.time || globalTime.from.time,
                timezone: pivotTime.from.timezone || globalTime.from.timezone
            },
            to: {
                date: pivotTime.to.date || globalTime.to.date,
                time: pivotTime.to.time || globalTime.to.time,
                timezone: pivotTime.to.timezone || globalTime.to.timezone
            }
        };

        if (!mergedTime.from.date && !mergedTime.to.date) { return undefined; }

        const flattenTime = function ({ date, time, timezone }, defaultTime) {
            const tz = timezone || "America/Los_Angeles";
            const dateStr = moment(date).utc().format('L');
            const timeStr = time === null || time === undefined ? defaultTime 
                : moment(time).utc().format('H:m:s');
            const s = moment.tz(`${dateStr} ${timeStr}`, 'L H:m:s', tz).unix();            
            return moment.unix(s).format(); //
        };

        const out = {
                ...(mergedTime.from.date ? {earliest_time: flattenTime(mergedTime.from, '0:0:0')} : {}),
                ...(mergedTime.to.date ? {latest_time: flattenTime(mergedTime.to, '23:59:59')} : {})
            };

        log.trace('Date range', pivotTime, globalTime, '->', mergedTime, '->', out);
        
        return out;
        
    }

    //Assumes previous pivots have populated pivotCache
    expandTemplate(text, pivotCache) {
        log.debug({toExpand: text}, 'Expanding');
        return buildLookup(text, pivotCache);
    }

    constructFieldString() {        
        const base = `
            | fields *
            | rename _cd as EventID
            | eval c_time=strftime(_time, "%Y-%d-%m %H:%M:%S")
            | rename c_time as time`;
        
        if (this.attributes && this.attributes.length > 0) {
            const fields = 
                ["time", "EventID"]
                    .concat(this.connections || [])
                    .concat(this.attributes || []);
            return `
                ${base} 
                | fields ${ fields.join(',') }`;
        } else {
            //all fields
            return `
                ${base} 
                | fields - ${splunkFieldsBlacklist.join(' ')}`;
        }
    }
}

function buildLookup(text, pivotCache) {

    //Special casing of [search] -[field]-> [source]
    //   search can be "{{pivot###}}""
    //   field can be  "field1, field2,field3, ..."
    //   source is any search
    const hit = text.match(/\[{{(.*)}}] *-\[(.*)]-> *\[(.*)]/);
    if (hit) {
        const search = hit[1];
        const fields = hit[2].split(',')
            .map(s => s.trim())
            .map(s => s[0] === '"' ? s.slice(1,-1).trim() : s);
        const source = hit[3];

        log.trace({search, fields, source}, 'Looking at');
        let match = '';
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            const vals = _.uniq(_.map(pivotCache[search].events, function (row) {
                return row[field];
            }));
            const fieldMatch = `"${ field }"="${ vals.join(`" OR "${ field }"="`) }"`;
            match = match + (match ? ' OR ' : '') + fieldMatch;
        }
        return `${ source } ${ match } | head 10000 `;
    } else {
        return undefined;
    }
}
