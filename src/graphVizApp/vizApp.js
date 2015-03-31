'use strict';

// FIXME: Move this to graph-viz repo -- it shouldn't be a part of the core StreamGL library

var debug   = require('debug')('graphistry:StreamGL:graphVizApp:vizApp');
var $       = window.$;
var Rx      = require('rx');
              require('../rx-jquery-stub');

var shortestpaths   = require('./shortestpaths.js');
var colorpicker     = require('./colorpicker.js');
var controls        = require('./controls.js');
var canvas          = require('./canvas.js');

var poiLib          = require('../poi.js');


// ... -> Observable renderState
function init(socket, $elt, renderState, vboUpdates, workerParams, urlParams) {
    debug('Initializing vizApp.');

    //////////////////////////////////////////////////////////////////////////
    // App State
    //////////////////////////////////////////////////////////////////////////

    var poi = poiLib(socket);
    // Observable DOM
    var labelHover = new Rx.Subject();
    var lastRender = new Rx.Subject();
    var currentlyRendering = new Rx.ReplaySubject(1);
    var settingsChanges = new Rx.ReplaySubject(1);
    settingsChanges.onNext({});

    // Marquee button selected
    var marqueeOn = new Rx.ReplaySubject(1);
    marqueeOn.onNext(false);
    // Marquee being drawn / dragged
    var marqueeActive = new Rx.ReplaySubject(1);
    marqueeActive.onNext(false);
    // Marquee finished drawing on the canvas
    // TODO: Do we really need this?
    var marqueeDone = new Rx.ReplaySubject(1);
    marqueeDone.onNext(false);
    // Simulate button selected
    var simulateOn = new Rx.ReplaySubject(1);
    simulateOn.onNext(false);
    // Brush button selected
    var brushOn = new Rx.ReplaySubject(1);
    brushOn.onNext(false);

    var appState = {
        labelHover: labelHover,
        lastRender: lastRender,
        currentlyRendering: currentlyRendering,
        poi: poi,
        settingsChanges: settingsChanges,
        marqueeOn: marqueeOn,
        marqueeActive: marqueeActive,
        marqueeDone: marqueeDone,
        simulateOn: simulateOn,
        brushOn: brushOn
    };


    //////////////////////////////////////////////////////////////////////////
    // Setup
    //////////////////////////////////////////////////////////////////////////

    canvas.setupRendering(appState);
    var colors = colorpicker($('#foregroundColor'), $('#backgroundColor'), socket);
    var renderStateUpdates = canvas.setupDragHoverInteractions($elt, renderState, colors.backgroundColor, appState);
    shortestpaths($('#shortestpath'), poi, socket);
    controls.init(socket, $elt, renderState, vboUpdates, workerParams, urlParams, appState);

    return renderStateUpdates;
}


module.exports = init;
