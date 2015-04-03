'use strict';

/*
    Client networking layer for connecting a local canvas to remote layout engine
*/

var debug        = require('debug')('graphistry:StreamGL:client');
var $            = window.$;
var Rx           = require('rx');
                   require('./rx-jquery-stub');
var _            = require('underscore');
var io           = require('socket.io-client');

var renderer     = require('./renderer.js');


//string * {socketHost: string, socketPort: int} -> (... -> ...)
// where fragment == 'vbo?buffer' or 'texture?name'
function makeFetcher (fragment, url) {
    //string * {<name> -> int} * name -> Subject ArrayBuffer
    return function (socketID, bufferByteLengths, bufferName) {

        debug('fetching', bufferName);

        var res = new Rx.Subject();

        //https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/Sending_and_Receiving_Binary_Data?redirectlocale=en-US&redirectslug=DOM%2FXMLHttpRequest%2FSending_and_Receiving_Binary_Data
        var oReq = new XMLHttpRequest();
        oReq.open('GET', url + '/' + fragment + '=' + bufferName + '&id=' + socketID, true);
        oReq.responseType = 'arraybuffer';

        var now = Date.now();
        oReq.onload = function () {
            try {
                debug('got texture/vbo data', bufferName, Date.now() - now, 'ms');

                var arrayBuffer = oReq.response; // Note: not oReq.responseText
                var blength = bufferByteLengths[bufferName];
                debug('Buffer length (%s): %d', bufferName, blength);
                var trimmedArray = new Uint8Array(arrayBuffer, 0, blength);

                res.onNext(trimmedArray);

            } catch (e) {
                console.error('Render error on loading data into WebGL:', e, e.stack);
            }
        };

        oReq.send(null);

        return res.take(1);
    };
}


// Filter for server resource names that have changed (or not previously present)
//[ String ] * ?{?<name>: int} * ?{?<name>: int} -> [ String ]
function getUpdatedNames (names, originalVersions, newVersions) {
    if (!originalVersions || !newVersions) {
        return names;
    }
    return names.filter(function (name) {
        return newVersions.hasOwnProperty(name) && (originalVersions[name] !== newVersions[name]);
    });
}


/**
 * Fetches the URL for the viz server to use
 */
function getVizServerParams(args) {

    var attempt = 0;

    return Rx.Observable.return().flatMap(function () {
            //wrap so can retry if claim race failure
            debug('Asking /vizaddr');
            return $.ajaxAsObservable({
                url: '/vizaddr/graph?' + args,
                dataType: 'json'
            });
        })
        .flatMap(function(reply) {

            attempt++;

            var ret = Rx.Observable.return(reply);
            return attempt === 1 ?  ret : (ret.delay(1000));

        })
        .map(function (reply) {

            if (!reply.data || reply.data.error) { //FIXME Check success value
                console.error('vizaddr returned error', reply, (reply.data||{}).error);
                var msg;
                if (reply.data && reply.data.error) {
                    msg = reply.data.error;
                } else {
                    msg = 'Cannot connect to visualization server (vizaddr)';
                }

                throw new Error(msg);
            }
            var params = {
                'hostname': reply.data.hostname,
                'port': reply.data.port,
                'url': '//' + reply.data.hostname + ':' + reply.data.port
            };

            console.info('Routed to', params.url, 'in', Date.now() - parseFloat(reply.data.timestamp), 'ms');
            return params;
        })
        .retry(3)
        .take(1);
}


function connect(vizType, urlParams) {
    debug('Connecting to visualization server');
    if (!vizType) {
        throw new Error('need vizType');
    }

    // Get URL query params to send over to the worker via socket
    var workerParams = ['dataset', 'scene', 'device', 'controls',
                        'mapper', 'type', 'vendor', 'usertag'];

    // For compatibility with old way of specifying dataset
    if ('datasetname' in urlParams) {
        urlParams.dataset = urlParams.datasetname;
    }

    var workersArgs = _.map(workerParams, function (param) {
        return param + '=' + urlParams[param];
    }).join('&');


    var attempt = 0;
    var latestError;

    return getVizServerParams(workersArgs)
        .flatMap(function (params) {
            return Rx.Observable.return()
                .do(function () {
                    attempt++;
                    if (attempt === 3) {
                        console.error('Last attempt failed');
                        alert('Stopping all attempts to connect.');
                        throw new Error(latestError);
                    }
                })
                .flatMap(function() {

                    debug('got params', params);

                    var socket = io(params.url, { query: workersArgs,
                                                reconnection: false,
                                                transports: ['websocket']
                                                });

                    socket.io.engine.binaryType = 'arraybuffer';

                    socket.io.on('connect_error', function () { // FIXME Cannot trigger this handler when testing. Bug?
                        console.error('error, socketio failed connect');
                        latestError = 'Failed to connect to GPU worker. Try refreshing the page...';

                        // FIXME: Cannot throw exception in callback. Must wrap in Rx
                        throw new Error(latestError);
                    });

                    debug('Stream client websocket connected to visualization server', vizType);

                    return Rx.Observable.fromCallback(socket.emit.bind(socket, 'viz'))(vizType)
                        .do(function (v) {
                            debug('notified viz type', v);
                        })
                        .map(function (res) {
                            if (res && res.success) {
                                return {params: params, socket: socket};
                            } else {
                                latestError = (res||{}).error || 'Connection rejected by GPU worker. Try refreshing the page...';
                                console.error('Viz rejected (likely due to multiple claimants)');
                                throw new Error (latestError);
                            }
                        });
                })
                .retry(3);
        });
}


function createRenderer(socket, canvas) {
    debug('Getting render-config from server');
    return Rx.Observable.fromCallback(socket.emit, socket)('render_config', null)
        .map(function (res) {
            if (res && res.success) {
                debug('Received render-config from server', res.renderConfig);
                return res.renderConfig;
            } else {
                throw new Error((res||{}).error || 'Cannot get render_config');
            }
        }).map(function (renderConfig) {
            var renderState = renderer.init(renderConfig, canvas);
            debug('Renderer created');
            return renderState;
        });
}



/**
 * Sets up event loop to receive VBO update messages from the server, load them onto the GPU and
 * render them.
 *
 * @param  {socket.io socket} socket - socket.io socket created when we connected to the server.
 * @param  {renderer} renderState    - The renderer object returned by renderer.create().
 *
 * @return {Rx.BehaviorSubject} {'start', 'received', 'rendered'} Rx subject that fires every time a frame is rendered.
 */
function handleVboUpdates(socket, renderState, renderStateUpdates) {
    //string * {<name> -> int} * name -> Subject ArrayBuffer
    //socketID, bufferByteLengths, bufferName
    var fetchBuffer = makeFetcher('vbo?buffer', socket.io.uri);

    //string * {<name> -> int} * name -> Subject ArrayBuffer
    //socketID, textureByteLengths, textureName
    var fetchTexture = makeFetcher('texture?texture', socket.io.uri);

    var buffers = renderState.get('buffers').toJS();
    var bufferNames = renderer.getServerBufferNames(renderState.get('config').toJS());
    var textureNames = renderer.getServerTextureNames(renderState.get('config').toJS());

    debug('Server buffers/textures', bufferNames, textureNames);

    var lastHandshake = Date.now();
    var renderedFrame = new Rx.BehaviorSubject(0);

    var previousVersions = {buffers: {}, textures: {}};

    var vboUpdateStep = 0;

    var latestState = new Rx.ReplaySubject(1);
    latestState.onNext(renderState);
    renderStateUpdates.subscribe(
        latestState,
        function (err) { console.error('handlevbo err', err, (err||{}).stack); });

    socket.on('vbo_update', function (data, handshake) {

        var thisStep = {step: vboUpdateStep++, data: data.step};

        $('#graph-node-count').text(data.elements.pointculled);
        $('#graph-edge-count').text((data.elements.edgeculled || data.elements.edgeculledindexed) / 2);

        try {
            debug('1. VBO update', thisStep);
            renderedFrame.onNext('start');

            var now = new Date().getTime();
            debug('2. got VBO update message', now - lastHandshake, data, 'ms', thisStep);

            var changedBufferNames  = getUpdatedNames(bufferNames,  previousVersions.buffers,  data.versions ? data.versions.buffers : null);
            var changedTextureNames = getUpdatedNames(textureNames, previousVersions.textures, data.versions ? data.versions.textures : null);

            socket.emit('planned_binary_requests', {buffers: changedBufferNames, textures: changedTextureNames});

            debug('3. changed buffers/textures', previousVersions, data.versions, changedBufferNames, changedTextureNames, thisStep);

            var readyBuffers = new Rx.ReplaySubject(1);
            var readyTextures = new Rx.ReplaySubject(1);

            var readyToRender = Rx.Observable.zip(readyBuffers, readyTextures, _.identity).share();
            Rx.Observable.combineLatest(
                    readyToRender, latestState,
                    function (_, renderState) { return [_,renderState]; })
                .filter(function (pair) {
                    return pair[1]; })
                .take(1)
                .subscribe(function (pair) {
                    var renderState = pair[1];
                    debug('6. All buffers and textures received, completing', thisStep);
                    handshake(Date.now() - lastHandshake);
                    lastHandshake = Date.now();
                    renderedFrame.onNext('received');
                    renderer.render(renderState, 'clientNewVbos', function () {
                        renderedFrame.onNext('rendered');
                    });
                },
                function (err) { console.error('6 err. readyToRender error', err, (err||{}).stack, thisStep); });

            var bufferVBOs = Rx.Observable.zipArray(
                [Rx.Observable.return()]
                    .concat(changedBufferNames.map(fetchBuffer.bind('', socket.io.engine.id, data.bufferByteLengths))))
                .take(1);

            bufferVBOs
                .subscribe(function (vbos) {
                    vbos.shift();

                    debug('4a. Got VBOs:', vbos.length, thisStep);
                    var bindings = _.object(_.zip(changedBufferNames, vbos));

                    debug('5a. got all VBO data', Date.now() - now, 'ms', bindings, thisStep);
                    socket.emit('received_buffers'); //TODO fire preemptively based on guess

                    try {
                        renderer.setNumElements(data.elements);
                        renderer.loadBuffers(renderState, buffers, bindings);
                        readyBuffers.onNext();
                    } catch (e) {
                        console.error('5a err. Render error on loading data into WebGL:', e, e.stack, thisStep);
                    }

                },
                function (err) { console.error('bufferVBOs error', err, (err||{}).stack, thisStep); });

            var textureLengths =
                _.object(_.pairs(_.pick(data.textures, changedTextureNames))
                    .map(function (pair) {
                        var name = pair[0];
                        var nfo = pair[1];
                        return [name, nfo.bytes]; }));

            var texturesData = Rx.Observable.zipArray(
                [Rx.Observable.return()]
                    .concat(changedTextureNames.map(fetchTexture.bind('', socket.io.engine.id, textureLengths))))
                .take(1);

            texturesData.subscribe(function (textures) {
                textures.shift();

                var textureNfos = changedTextureNames.map(function (name, i) {
                    return _.extend(data.textures[name], {buffer: textures[i]});
                });

                var bindings = _.object(_.zip(changedTextureNames, textureNfos));

                debug('4b. Got textures', textures, thisStep);
                renderer.loadTextures(renderState, bindings);

                readyTextures.onNext();
            }, function (err) { console.error('5b.readyToRender error', err, (err||{}).stack, thisStep); });

            _.keys(data.versions).forEach(function (mode) {
                previousVersions[mode] = previousVersions[mode] || {};
                _.keys(data.versions[mode]).forEach(function (name) {
                    previousVersions[mode][name] = (data.versions[mode] || {})[name] || previousVersions[mode][name];
                });
            });

        } catch (e) {
            debug('ERROR vbo_update', e, e.stack, thisStep);
        }
    });

    socket.emit('begin_streaming');

    return renderedFrame;
}

module.exports = {
    connect: connect,
    createRenderer: createRenderer,
    handleVboUpdates: handleVboUpdates
};
