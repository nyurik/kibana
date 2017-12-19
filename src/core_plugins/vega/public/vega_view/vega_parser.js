import _ from 'lodash';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import schemaParser from 'vega-schema-url-parser';
import versionCompare from 'compare-versions';
import { EsQueryParser } from './es_query_parser';
import hjson from 'hjson';
import { ViewUtils } from './view_utils';

const DEFAULT_SCHEMA = 'https://vega.github.io/schema/vega/v3.0.json';

const locToDirMap = {
  left: 'row-reverse',
  right: 'row',
  top: 'column-reverse',
  bottom: 'column'
};

export class VegaParser {

  constructor(spec, es, timefilter, dashboardContext) {
    this.spec = spec;
    this.hideWarnings = false;
    this.error = undefined;
    this.warnings = [];
    this.es = es;
    this.esQueryParser = new EsQueryParser(timefilter, dashboardContext);
  }

  async parseAsync() {
    try {
      await this._parseAsync();
    } catch (err) {
      // if we reject current promise, it will use the standard Kibana error handling
      this.error = ViewUtils.formatErrorToStr(err);
    }
    return this;
  }

  async _parseAsync() {
    if (this.isVegaLite !== undefined) throw new Error();

    if (typeof this.spec === 'string') {
      this.spec = hjson.parse(this.spec, { legacyRoot: false });
    }
    if (!_.isPlainObject(this.spec)) {
      throw new Error('Invalid Vega spec');
    }
    this.isVegaLite = this._parseSchema();
    this.useHover = !this.isVegaLite;
    this.config = this._parseConfig();
    this.hideWarnings = !!this.config.hideWarnings;
    this.useMap = this.config.type === 'map';

    this._setDefaultColors();
    this._parseControlPlacement(this.config);
    if (this.useMap) {
      this.mapConfig = this._parseMapConfig();
    } else if (this.spec.autosize === undefined) {
      // Default autosize should be fit, unless it's a map (leaflet-vega handles that)
      this.spec.autosize = { type: 'fit', contains: 'padding' };
    }

    await this._resolveEsQueriesAsync();

    if (this.isVegaLite) {
      this._compileVegaLite();
    }
    this._calcSizing();
  }

  /**
   * Convert VegaLite to Vega spec
   * @private
   */
  _compileVegaLite() {
    if (this.useMap) {
      throw new Error('"_map" configuration is not compatible with vega-lite spec');
    }
    this.vlspec = this.spec;

    const logger = vega.logger(vega.Warn);
    logger.warn = this._onWarning.bind(this);
    this.spec = vegaLite.compile(this.vlspec, logger).spec;
  }

  /**
   * Process graph size and padding
   * @private
   */
  _calcSizing() {
    this.useResize = !this.useMap && (this.spec.autosize === 'fit' || this.spec.autosize.type === 'fit');

    // Padding is not included in the width/height by default
    this.paddingWidth = 0;
    this.paddingHeight = 0;
    if (this.useResize && this.spec.padding && this.spec.autosize.contains !== 'padding') {
      if (typeof this.spec.padding === 'object') {
        this.paddingWidth += (+this.spec.padding.left || 0) + (+this.spec.padding.right || 0);
        this.paddingHeight += (+this.spec.padding.top || 0) + (+this.spec.padding.bottom || 0);
      } else {
        this.paddingWidth += 2 * (+this.spec.padding || 0);
        this.paddingHeight += 2 * (+this.spec.padding || 0);
      }
    }

    if (this.useResize && (this.spec.width || this.spec.height)) {
      if (vegaLite) {
        delete this.spec.width;
        delete this.spec.height;
      } else {
        this._onWarning(`The 'width' and 'height' params are ignored with autosize=fit`);
      }
    }
  }

  /**
   * Calculate container-direction CSS property for binding placement
   * @private
   */
  _parseControlPlacement() {
    this.containerDir = locToDirMap[this.config.controlsLocation];
    if (this.containerDir === undefined) {
      if (this.config.controlsLocation === undefined) {
        this.containerDir = 'column';
      } else {
        throw new Error('Unrecognized controlsLocation value. Expecting one of ["' +
          locToDirMap.keys().join('", "') + '"]');
      }
    }
    const dir = this.config.controlsDirection;
    if (dir !== undefined && dir !== 'horizontal' && dir !== 'vertical') {
      throw new Error('Unrecognized dir value. Expecting one of ["horizontal", "vertical"]');
    }
    this.controlsDir = dir === 'horizontal' ? 'row' : 'column';
  }

  /**
   * Parse {config: kibana: {...}} portion of the Vega spec (or root-level _hostConfig for backward compat)
   * @returns {object}
   * @private
   */
  _parseConfig() {
    let result;
    if (this.spec._hostConfig !== undefined) {
      result = this.spec._hostConfig;
      delete this.spec._hostConfig;
      if (!_.isPlainObject(result)) {
        throw new Error('If present, _hostConfig must be an object');
      }
      this._onWarning('_hostConfig has been deprecated. Use config.kibana instead.');
    }
    if (_.isPlainObject(this.spec.config) && this.spec.config.kibana !== undefined) {
      result = this.spec.config.kibana;
      delete this.spec.config.kibana;
      if (!_.isPlainObject(result)) {
        throw new Error('If present, config.kibana must be an object');
      }
    }
    return result || {};
  }

  /**
   * Parse map-specific configuration
   * @returns {{mapStyle: *|string, delayRepaint: boolean, latitude: number, longitude: number, zoom, minZoom, maxZoom, zoomControl: *|boolean, maxBounds: *}}
   * @private
   */
  _parseMapConfig() {
    const res = {
      delayRepaint: this.config.delayRepaint === undefined ? true : this.config.delayRepaint,
    };

    const validate = (name, isZoom) => {
      const val = this.config[name];
      if (val !== undefined) {
        const parsed = Number.parseFloat(val);
        if (Number.isFinite(parsed) && (!isZoom || (parsed >= 0 && parsed <= 30))) {
          res[name] = parsed;
          return;
        }
        this._onWarning(`config.kibana.${name} is not valid`);
      }
      if (!isZoom) res[name] = 0;
    };

    validate(`latitude`, false);
    validate(`longitude`, false);
    validate(`zoom`, true);
    validate(`minZoom`, true);
    validate(`maxZoom`, true);

    // `false` is a valid value
    res.mapStyle = this.config.mapStyle === undefined ? `default` : this.config.mapStyle;
    if (res.mapStyle !== `default` && res.mapStyle !== false) {
      this._onWarning(`config.kibana.mapStyle may either be false or "default"`);
      res.mapStyle = `default`;
    }

    const zoomControl = this.config.zoomControl;
    if (zoomControl === undefined) {
      res.zoomControl = true;
    } else if (typeof zoomControl !== 'boolean') {
      this._onWarning('config.kibana.zoomControl must be a boolean value');
      res.zoomControl = true;
    } else {
      res.zoomControl = zoomControl;
    }

    const maxBounds = this.config.maxBounds;
    if (maxBounds !== undefined) {
      if (!Array.isArray(maxBounds) || maxBounds.length !== 4 ||
        !maxBounds.every(v => typeof v === 'number' && Number.isFinite(v))
      ) {
        this._onWarning(`config.kibana.maxBounds must be an array with four numbers`);
      } else {
        res.maxBounds = maxBounds;
      }
    }

    return res;
  }

  /**
   * Parse Vega schema element
   * @returns {boolean} is this a VegaLite schema?
   * @private
   */
  _parseSchema() {
    if (!this.spec.$schema) {
      this._onWarning(`The input spec does not specify a "$schema", defaulting to "${DEFAULT_SCHEMA}"`);
      this.spec.$schema = DEFAULT_SCHEMA;
    }

    const schema = schemaParser(this.spec.$schema);
    const isVegaLite = schema.library === 'vega-lite';
    const libVersion = isVegaLite ? vegaLite.version : vega.version;

    if (versionCompare(schema.version, libVersion) > 0) {
      this._onWarning(
        `The input spec uses ${schema.library} ${schema.version}, but ` +
        `current version of ${schema.library} is ${libVersion}.`
      );
    }

    return isVegaLite;
  }

  /**
   * Replace all instances of ES requests with raw values
   * @private
   */
  async _resolveEsQueriesAsync() {
    // TODO: switch to ES multi-search, instead of doing it one by one
    const sources = [];
    this._findEsRequests((obj, esReq) => sources.push({ obj, esReq }), this.spec);

    for (const { obj, esReq } of sources) {
      const values = await this.es.search(esReq);
      obj.values = values;
    }
  }

  /**
   * Recursively find and callback every instance of ES data object
   * @param {function({object}, {object})} onFind Call this function for all ES queries
   * @param {*} obj current location in the object tree
   * @param {string} [key] field name of the current object
   * @private
   */
  _findEsRequests(onFind, obj, key) {
    if (Array.isArray(obj)) {
      for (const elem of obj) {
        this._findEsRequests(onFind, elem, key);
      }
    } else if (_.isPlainObject(obj)) {
      if (key === 'data') {
        // Assume that any  "data": {...}  is a request for data
        const { esRequest, esIndex, esContext } = obj;
        if (esRequest !== undefined || esIndex !== undefined || esContext !== undefined) {
          if (obj.url !== undefined || obj.values !== undefined || obj.source !== undefined) {
            throw new Error('Data must not have "url", "values", and "source" when using ' +
              'Elasticsearch parameters like esRequest, esIndex, or esContext.');
          }
          delete obj.esRequest;
          delete obj.esIndex;
          delete obj.esContext;
          onFind(obj, this.esQueryParser.parseEsRequest(esRequest, esIndex, esContext));
        }
      } else {
        for (const k of Object.keys(obj)) {
          this._findEsRequests(onFind, obj[k], k);
        }
      }
    }
  }

  /**
   * Inject default colors into the spec.config
   * @private
   */
  _setDefaultColors() {
    // Default category coloring to the Elastic color scheme
    this._setDefaultValue({ scheme: 'elastic' }, 'config', 'range', 'category');

    // Set default single color to match other Kibana visualizations
    const defaultColor = '#00A69B';
    if (this.isVegaLite) {
      // Vega-Lite: set default color, works for fill and strike --  config: { mark:  { color: '#00A69B' }}
      this._setDefaultValue(defaultColor, 'config', 'mark', 'color');
    } else {
      // Vega - global mark has very strange behavior, must customize each mark type individually
      // https://github.com/vega/vega/issues/1083
      // Don't set defaults if spec.config.mark.color or fill are set
      if (!this.spec.config.mark || (this.spec.config.mark.color === undefined && this.spec.config.mark.fill === undefined)) {
        this._setDefaultValue(defaultColor, 'config', 'arc', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'area', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'line', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'path', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'rect', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'rule', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'shape', 'stroke');
        this._setDefaultValue(defaultColor, 'config', 'symbol', 'fill');
        this._setDefaultValue(defaultColor, 'config', 'trail', 'fill');
      }
    }
  }

  /**
   * Set default value if it doesn't exist.
   * Given an object, and an array of fields, ensure that obj.fld1.fld2. ... .fldN is set to value if it doesn't exist.
   * @param {*} value
   * @param {string} fields
   * @private
   */
  _setDefaultValue(value, ...fields) {
    let o = this.spec;
    for (let i = 0; i < fields.length - 1; i++) {
      const field = fields[i];
      const subObj = o[field];
      if (subObj === undefined) {
        o[field] = {};
      } else if (!_.isPlainObject(subObj)) {
        return;
      }
      o = o[field];
    }
    const lastField = fields[fields.length - 1];
    if (o[lastField] === undefined) {
      o[lastField] = value;
    }
  }

  /**
   * Add a warning to the warnings array
   * @private
   */
  _onWarning() {
    if (!this.hideWarnings) {
      this.warnings.push(ViewUtils.formatWarningToStr(...arguments));
    }
  }
}