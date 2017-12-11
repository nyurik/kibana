import { VegaParser } from './vega_view';
import { dashboardContextProvider } from 'plugins/kibana/dashboard/dashboard_context';

export function VegaRequestHandlerProvider(Private, es, timefilter) {

  const dashboardContext = Private(dashboardContextProvider);

  return {
    name: 'vegavis',
    handler: (vis, appState, uiState) => {
      const vp = new VegaParser(vis.params.spec, es, timefilter, dashboardContext,
        { vis, appState, uiState });
      return vp.parse();

    }
  };
}
