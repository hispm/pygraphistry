import { Observable } from 'rxjs';
import { simpleflake } from 'simpleflakes';
var hash = require('object-hash');
import _  from 'underscore';


//Do not make these nodes in '*' mode
const SKIP = {

    //MYSTERY
    'tag::eventtype': true,

    //ALERT DEMO //TODO stitch in based on pivot
    'Alert Category': true,
    'destination': true,
    'destinationType': true,
    'Search': true,
    'Search Depth': true,
    'edgeType': true,
    'weight': true,


    //SPLUNK //TODO stitch in based on pivot
    '_bkt': true,
    '_cd': true,
    '_indextime': true,
    '_kv': true,
    '_raw': true,
    '_serial': true,
    '_si': true,
    '_sourcetype': true,
    '_time': true,
    '_timediff': true,
    'date_minute': true,
    'date_second': true,
    'date_hour': true,
    'date_mday': true,
    'date_month': true,
    'date_wday': true,
    'date_year': true,
    'date_zone': true,
    'extracted_source': true,
    'extracted_sourceType': true,
    'host': true,
    'index': true,
    'index_time': true,
    'level': true,
    'linecount': true,
    'module': true,
    'punct': true,
    'Search': true,
    'source': true,
    'sourcetype': true,
    'splunk_server': true,
    'splunk_server_group': true,
    'time': true,
    'timestamp': true,
    'unix_category': true,
    'unix_group': true,
    'vendor': true,
    'vendor_product': true,

    //HEALTH DEMO //TODO stitch in based on pivot
    'AdmissionEndDate': true,
    'AdmissionStartDate': true,
    'LabDateTime': true,
    'LabValue': true,
    'LabUnits': true
};

export function shapeSplunkResults(splunkResults, pivotDict, index) {
    const destination = pivotDict['Search'];
    const connections = pivotDict['Links'];
    const connectionsArray = connections.split(',').map((connection) => connection.trim());
    const isStar = connectionsArray.indexOf('*') != -1;

    return splunkResults
        .map(function(rows) {
            const edges = [];
            const nodeLabels = [];
            for(let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const eventID = row['EventID'] || simpleflake().toJSON();
                nodeLabels.push({"node": eventID, type:'EventID'});

                const fields =
                    isStar ?
                        _.filter(Object.keys(row), function (field) {
                            return !SKIP[field] && (field.toLowerCase() !== 'eventid');
                        })
                    : _.filter(connectionsArray, function (field) { return row[field]; });

                for (var j = 0; j < fields.length; j++) {
                    const field = fields[j];

                    if (field === 'Search') {
                        edges.push(Object.assign({}, row,
                            {'destination': destination,
                             'source': eventID,
                             'edgeType': ('EventID->Search'),
                             'pivot': index}))
                        nodeLabels.push({"node": destination, type:'Search'});
                        continue;
                    }

                    nodeLabels.push({"node": row[field], type: field});
                    edges.push(Object.assign({}, row,
                        {'destination': row[field],
                         'source': eventID,
                         'edgeType': ('EventID->' + field),
                         'pivot': index}));
                }

            }

            return {
                graph: edges,
                labels: nodeLabels,
            };
        })
}
