import { Pivot } from 'pivot-shared/pivots';
import { Template } from 'pivot-shared/templates';
import { Investigation } from 'pivot-shared/investigations';
import { container } from '@graphistry/falcor-react-redux';

import {
    saveLayout,
    splicePivot,
    insertPivot,
    searchPivot,
    dismissAlert,
    togglePivots,
    graphInvestigation,
} from 'pivot-shared/actions/investigation';

import {
    copyInvestigation,
    saveInvestigation,
    createInvestigation,
} from 'pivot-shared/actions/investigationScreen';


export const investigationContainer = container({
    fragment: ({ pivots } = {}) => `{
        id, name, status, eventTable, modifiedOn, description, tags, url, layout,
        pivots: ${
            Pivot.fragments(pivots)
        }
    }`,
    mapFragment: ({ id, name, pivots, status, eventTable, layout } = {}) => ({
        id, name, pivots, status, eventTable, layout
    }),
    dispatchers: {
        splicePivot,
        insertPivot,
        searchPivot,
        dismissAlert,
        togglePivots,
        saveInvestigation,
        copyInvestigation,
        graphInvestigation,
    }
});


export const investigationScreenContainer = container({
    renderLoading: false,
    fragment: ({ templates, investigations, activeInvestigation } = {}) => `{
        activeScreen,
        templates: ${ Template.fragments(templates) },
        investigations: ${ Investigation.fragments(investigations) },
        activeInvestigation: ${ Investigation.fragment(activeInvestigation) }
    }`,
    mapFragment: (user = {}) => ({
        user, ...user
    }),
    dispatchers: {
        saveLayout,
        createInvestigation,
        copyInvestigation,
        saveInvestigation
    }
});
