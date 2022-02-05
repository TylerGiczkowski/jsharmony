/*
Copyright 2017 apHarmony

This file is part of jsHarmony.

jsHarmony is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

jsHarmony is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public License
along with this package.  If not, see <http://www.gnu.org/licenses/>.
*/

var Helper = require('./lib/Helper.js');
var _ = require('lodash');

module.exports = exports = {};

exports.getModelMultisel = function (req, res, fullmodelid, Q, P) {
  var _this = this;
  var model = this.jsh.getModel(req, fullmodelid);
  if (!Helper.hasModelAction(req, model, 'B')) { Helper.GenError(req, res, -11, _this._tP('Invalid Model Access for @fullmodelid', { fullmodelid })); return; }
  var fieldlist = this.getFieldNames(req, model.fields, 'B');
  var foreignkeylist = this.getFieldNames(req, model.fields, 'F');
  var lovkeylist = this.getFieldNamesWithProp(model.fields, 'lovkey');
  var lovfield = null;
  _.each(model.fields, function (field) {
    if (field.lov) {
      if (lovfield == null) lovfield = field;
      else throw new Error('Invalid Multisel - Can only have one LOV field.');
    }
  });
  if (lovfield == null) throw new Error('Invalid Multisel - No LOV field.');
  var allfieldslist = _.union([lovfield.name], fieldlist);
  var allfields = this.getFieldsByName(model.fields, allfieldslist);
  var db = _this.jsh.getModelDB(req, fullmodelid);
  
  var is_insert = true;
  if (_this.ParamCheck('Q', Q, _.union(_.map(foreignkeylist, function (foreignkey) { return '&' + foreignkey; }), ['|_action']), false)) { is_insert = false; }
  else if (_this.ParamCheck('Q', Q, _.map(lovkeylist, function (lovkey) { return '|' + lovkey; }), false)) { /* OK */ }
  else { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
  if (!_this.ParamCheck('P', P, [])) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }

  var is_browse = (('_action' in Q) && (Q['_action'] == 'browse'));
  
  var sql_ptypes = [];
  var sql_params = {};
  var verrors = {};
  var datalockqueries = [];
  var lov_datalockqueries = [];
  var param_datalocks = [];
  var sql_foreignkeys = [];
  
  if (!is_insert) _.each(foreignkeylist, function (val) { sql_foreignkeys.push(val); });
  var sql_foreignkeyfields = this.getFieldsByName(model.fields, sql_foreignkeys);
  
  //Add DataLock parameters to SQL
  this.getDataLockSQL(req, model, model.fields, sql_ptypes, sql_params, verrors, function (datalockquery, dfield) {
    if ('lovkey' in dfield) return false; //DATALOCK validation handled  below in prefix
    datalockqueries.push(datalockquery);
    return true;
  }, null, fullmodelid);
  
  var lov = lovfield.lov;
  if ('sql' in lov) {
    _this.getDataLockSQL(req, model, [lov], sql_ptypes, sql_params, verrors, function (datalockquery) {
      lov_datalockqueries.push(datalockquery);
    }, null, fullmodelid + '_lov');
    
    //Add LOV parameters
    if ('sql_params' in lov) {
      var lov_pfields = _this.getFieldsByName(model.fields, lov.sql_params);
      for (let i = 0; i < lov_pfields.length; i++) {
        var lov_pfield = lov_pfields[i];
        var lov_pname = lov_pfield.name;
        if (!(lov_pname in Q)) {
          sql_ptypes.push(_this.getDBType(lov_pfield));
          sql_params[lov_pname] = null;
        }
      }
    }
  }
  if (!_.isEmpty(verrors)) { Helper.GenError(req, res, -2, verrors[''].join('\n')); return; }
  
  //Add dynamic parameters from query string
  var keys = [];
  if (is_insert) keys = this.getFieldsByName(model.fields, lovkeylist);
  else keys = this.getFieldsByName(model.fields, foreignkeylist);
  for (let i = 0; i < keys.length; i++) {
    var field = keys[i];
    var fname = field.name;
    if (fname in Q) {
      var dbtype = _this.getDBType(field);
      sql_ptypes.push(dbtype);
      sql_params[fname] = _this.DeformatParam(field, Q[fname], verrors);
      _this.getDataLockSQL(req, model, model.fields, sql_ptypes, sql_params, verrors, function (datalockquery, dfield) {
        if (dfield != field) return false;
        param_datalocks.push({ pname: fname, datalockquery: datalockquery, field: dfield });
        return true;
      }, null, fullmodelid + '_key');
    }
    else { if (is_insert) continue; _this.jsh.Log.warning('Missing parameter ' + fname); Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
  }
  
  verrors = _.merge(verrors, model.xvalidate.Validate('KF', sql_params));
  if (!_.isEmpty(verrors)) { Helper.GenError(req, res, -2, verrors[''].join('\n')); return; }
  
  var sql = db.sql.getModelMultisel(_this.jsh, model, lovfield, allfields, sql_foreignkeyfields, datalockqueries, lov_datalockqueries, param_datalocks);
  
  var dbtasks = {};
  dbtasks[fullmodelid] = function (dbtrans, callback) {
    db.Recordset(req._DBContext, sql, sql_ptypes, sql_params, dbtrans, function (err, rslt, stats) {
      if ((err == null) && (rslt == null)) err = Helper.NewError('Record not found', -1);
      if (err != null) { err.model = model; err.sql = sql; }
      if (stats) stats.model = model;
      callback(err, rslt, stats);
    });
  };
  //Title Tasks
  if(_this.addTitleTasks(req, res, model, Q, dbtasks, (is_insert?'I':(is_browse?'B':'U')))===false) return;
  
  return dbtasks;
};

exports.postModelMultisel = function (req, res, fullmodelid, Q, P, onComplete) {
  if (!this.jsh.hasModel(req, fullmodelid)) throw new Error('Error: Model ' + fullmodelid + ' not found in collection.');
  var _this = this;
  var model = this.jsh.getModel(req, fullmodelid);
  if (!Helper.hasModelAction(req, model, 'U')) { Helper.GenError(req, res, -11, _this._tP('Invalid Model Access for @fullmodelid', { fullmodelid })); return; }
  
  var lovfield = null;
  _.each(model.fields, function (field) {
    if (field.lov) {
      if (lovfield == null) lovfield = field;
      else throw new Error('Invalid Multisel - Can only have one LOV field.');
    }
  });
  if (lovfield == null) throw new Error('Invalid Multisel - No LOV field.');
  var foreignkeylist = _this.getFieldNames(req, model.fields, 'F');
  var foreignkeyfields = this.getFieldsByName(model.fields, foreignkeylist);
  var db = _this.jsh.getModelDB(req, fullmodelid);
  
  if (!_this.ParamCheck('Q', Q, _.map(foreignkeylist, function (foreignkey) { return '&' + foreignkey; }))) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
  if (!_this.ParamCheck('P', P, ['&' + lovfield.name])) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
  
  var lovvals = JSON.parse(P[lovfield.name]);
  if (!_.isArray(lovvals)) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
  for (let i = 0; i < lovvals.length; i++) {
    if (!_.isString(lovvals[i])) { Helper.GenError(req, res, -4, 'Invalid Parameters'); return; }
    lovvals[i] = lovvals[i].toString();
  }
  
  var sql_ptypes = [];
  var sql_params = {};
  var verrors = {};
  var param_datalocks = [];
  var datalockqueries = [];
  var lov_datalockqueries = [];
  
  var subs = [];
  //Add key from query string
  for (let i = 0; i < lovvals.length; i++) {
    var lovval = lovvals[i];
    var fname = 'multisel' + i;
    var dbtype = _this.getDBType(lovfield);
    sql_ptypes.push(dbtype);
    sql_params[fname] = _this.DeformatParam(lovfield, lovval, verrors);
  }
  
  //Add foreign key fields
  var fields = _this.getFields(req, model.fields, 'F');
  if (fields.length == 0) return onComplete(null, {});
  _.each(fields, function (field) {
    var fname = field.name;
    if (fname in Q) {
      var dbtype = _this.getDBType(field);
      sql_ptypes.push(dbtype);
      if (Q[fname] == '%%%' + fname + '%%%') { subs.push(fname); Q[fname] = ''; }
      sql_params[fname] = _this.DeformatParam(field, Q[fname], verrors);
      //Add PreCheck, if type='F'
      _this.getDataLockSQL(req, model, model.fields, sql_ptypes, sql_params, verrors, function (datalockquery, dfield) {
        if (dfield != field) return false;
        param_datalocks.push({ pname: fname, datalockquery: datalockquery, field: dfield });
        return true;
      });
    }
    else throw new Error('Missing parameter ' + fname);
  });
  
  //Add DataLock parameters to SQL
  _this.getDataLockSQL(req, model, model.fields, sql_ptypes, sql_params, verrors, function (datalockquery, dfield) {
    if ('lovkey' in dfield) return false; //DATALOCK lovkey validation not necessary here, this only checks existing data
    datalockqueries.push(datalockquery);
    return true;
  });
  
  var lov = lovfield.lov;
  if ('sql' in lov) {
    _this.getDataLockSQL(req, model, [lov], sql_ptypes, sql_params, verrors, function (datalockquery) { lov_datalockqueries.push(datalockquery); });
    
    if ('sql_params' in lov) {
      var lov_pfields = _this.getFieldsByName(model.fields, lov.sql_params);
      for (let i = 0; i < lov_pfields.length; i++) {
        var lov_pfield = lov_pfields[i];
        var lov_pname = lov_pfield.name;
        if (!(lov_pname in Q)) {
          sql_ptypes.push(_this.getDBType(lov_pfield));
          sql_params[lov_pname] = null;
        }
      }
    }
  }
  if (!_.isEmpty(verrors)) { Helper.GenError(req, res, -2, verrors[''].join('\n')); return; }
  
  //Validate Key and Foreign Key
  verrors = _.merge(verrors, model.xvalidate.Validate('KF', sql_params));
  if (!_.isEmpty(verrors)) { Helper.GenError(req, res, -2, verrors[''].join('\n')); return; }
  _.each(subs, function (fname) { sql_params[fname] = '%%%' + fname + '%%%'; });
  
  var sql = db.sql.postModelMultisel(_this.jsh, model, lovfield, lovvals, foreignkeyfields, param_datalocks, datalockqueries, lov_datalockqueries);
  
  var dbtasks = {};
  dbtasks[fullmodelid] = function (dbtrans, callback, transtbl) {
    sql_params = _this.ApplyTransTblEscapedParameters(sql_params, transtbl);
    db.Row(req._DBContext, sql, sql_ptypes, sql_params, dbtrans, function (err, rslt, stats) {
      if (err != null) { err.model = model; err.sql = sql; }
      if (stats) stats.model = model;
      callback(err, rslt, stats);
    });
  };
  return onComplete(null, dbtasks);
};

return module.exports;