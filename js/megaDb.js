/**
 * Mega DB Wrapper around db.js
 */

/**
 * Mega DB wrapper
 *
 * @param suffix {string} used for suffixing the db name
 * @param name {string} name of the database (a-zA-Z0-9_-)
 * @param version {Integer} version
 * @param schema {Object} db schema (IndexedDB format)
 * @returns {MegaDB}
 * @constructor
 */
function MegaDB(name, suffix, version, schema, options) {
    this.name = name;
    this.suffix = suffix;


    this.logger = new MegaLogger("megaDB[" + name + "]", {}, options && options.parentLogger ? options.parentLogger : undefined);


    this.server = null;

    this.currentVersion = version;
    this.schema = schema;
    this.dbState = MegaDB.DB_STATE.OPENING;
    this.plugins = {};
    this.options = $.extend({}, clone(MegaDB.DEFAULT_OPTIONS), options);

    var self = this;

    // init code goes here
    $.each(self.options.plugins, function(k, v) {
        self.plugins[k] = new v(self);
    });


    self._dbOpenPromise = db.open({
        server: 'mdb_' + name + '_' + suffix,
        version: version,
        schema: schema
    }).then( function ( s ) {
        self.server = s;
        self.dbState = MegaDB.DB_STATE.INITIALIZED;
        self.initialize();
    }, function() {
        self.dbState = MegaDB.DB_STATE.FAILED_TO_INITIALIZE;
        self.logger.error("Could not initialise MegaDB: ", arguments, name, version, schema);
    });

    return this;
};

makeObservable(MegaDB);

/**
 * Static, DB state
 */
MegaDB.DB_STATE = {
    'OPENING': 0,
    'INITIALIZED': 10,
    'FAILED_TO_INITIALIZE': 20,
    'CLOSED': 30
};

/**
 * Static, default options
 */
MegaDB.DEFAULT_OPTIONS = {
    'plugins': {
        'megaDbEncryptionPlugin': MegaDBEncryption
    }
};


/**
 * Wrap `fn` with a function which will create a "proxy" promise, which will wait for the DB state to be ready and then
 * actually execute the code in `fn`
 *
 * @param fn {Function} the function, which should be wrapped
 * @returns {Function}
 * @private
 */
MegaDB._delayFnCallUntilDbReady = function(fn) {
    return function() {
        var self = this;
        var megaDb = this;
        if(megaDb instanceof MegaDB.QuerySet) {
            megaDb = self.megaDb;
        }
        var args = toArray(arguments);

        assert(megaDb.dbState != MegaDB.DB_STATE.CLOSED, "Tried to execute method on a closed database.");
        assert(megaDb.dbState != MegaDB.DB_STATE.FAILED_TO_INITIALIZE, "Tried to execute method on a database which failed to initialize (open).");

        if(megaDb.dbState === MegaDB.DB_STATE.INITIALIZED) {
            return fn.apply(self, args);
        } else if(megaDb.dbState === MegaDB.DB_STATE.OPENING) {
            var $promise = new MegaPromise();


            megaDb._dbOpenPromise.then(
                function() {
                    try {
                        var resultPromise = fn.apply(self, args);
                    } catch(e) {
                        $promise.reject.apply($promise, arguments);
                    }

                    if(resultPromise.then) {
                        resultPromise.then(
                            function() {
                                $promise.resolve.apply($promise, arguments);
                            },
                            function() {
                                $promise.reject.apply($promise, arguments);
                            }
                        );
                    } else {
                        $promise.resolve.apply($promise, arguments);
                    }
                },function() {
                    $promise.reject.apply($promise, arguments);
                }
            );

            return $promise;
        }
    }
};


/**
 * Place holder for code, which should be executed to initialize the db (executed when the db is ready)
 * Also, trigger "onReady" event on the MegaDB instance.
 *
 */
MegaDB.prototype.initialize = function() {
    var self = this;

    // trigger ready
    self.trigger('onReady');
};


/**
 * add a db record
 *
 * @param tableName {String} name of the table in which the object/row should be inserted
 * @param val {Object} object containing data to be inserted
 * @returns {MegaPromise}
 */
MegaDB.prototype.add = function(tableName, val) {
    assert(this.server[tableName], 'table not found:' + tableName);

    var tempObj = clone(val);

    Object.keys(tempObj).forEach(function(k) {
        // ignore any __privateProperties and
        if(k.toString().indexOf("__") === 0) {
            delete tempObj[k];
        }
    });

    return this.server[tableName].add(tempObj)
        .then(function() {
            // get back the .id after .add is done
            if(tempObj.id && tempObj.id != val.id) {
                val.id = tempObj.id;
            }
        });
};

MegaDB.prototype.add = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(
        MegaDB.prototype.add
    ),
    'Add'
);


/**
 * Update an object/row, where `k` should be the ID of the object which should be updated
 *
 * @param tableName {String}
 * @param k {Integer} id of the object to be updated
 * @param val {Object} actual object, which will be used to replace the values in the current db
 * @returns {MegaPromise}
 */
MegaDB.prototype.update = function(tableName, k, val) {
    var self = this;

    assert(this.server[tableName], 'table not found:' + tableName);

    // ignore any __privateProperties and get back the .id after .add is done
    var tempObj = clone(val);

    Object.keys(tempObj).forEach(function(k) {
        if(k.toString().indexOf("__") === 0) {
            delete tempObj[k];
        }
    });

    return self.query(tableName)
        .filter('id', k)
        .modify(tempObj)
        .execute();
};

MegaDB.prototype.update = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(
        MegaDB.prototype.update
    ),
    'Update'
);


/**
 * Remove a row/object from `tableName` which pk/id equals to `id`
 *
 * @param tableName
 * @param id
 * @returns {MegaPromise}
 */
MegaDB.prototype.remove = function(tableName, id) {
    return this.removeBy(
        tableName,
        "id",
        id
    );
};
MegaDB.prototype.remove = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(
        MegaDB.prototype.remove
    ),
    'Remove'
);


/**
 * Remove object, which have a property `keyName` with value `value` (alias of .query(tableName).filter(keyName, value)
 * + remove)
 *
 * @param tableName {String}
 * @param keyName {String}
 * @param value {String|Integer}
 * @returns {MegaPromise}
 */
MegaDB.prototype.removeBy = function(tableName, keyName, value) {
    var self = this;

    var q = self.query(tableName);
    if(!value && $.isPlainObject(keyName)) {
        Object.keys(keyName).forEach(function(k) {
            var v = keyName[k];
            q = q.filter(k, v);
        });
    } else {
        q = q.filter(keyName, value)
    }


    var promise = new $.Deferred();

    q.execute()
        .then(function(r) {
            var promises = [];
            if(r.length && r.length > 0) { // found
                r.forEach(function(v) {
                    promises.push(
                        self.server.remove(tableName, v["id"])
                    );
                });
            }

            Promise.all(promises).then(function(ar) {
                promise.resolve(ar);
            }, function(ar) {
                promise.reject(ar)
            });
        }, function() {
            promise.reject(arguments);
        });

    return promise;
};


/**
 * Truncate a database (warning: this method will not reset the auto incremental counter!)
 *
 * @param tableName {String}
 * @returns {MegaPromise}
 */
MegaDB.prototype.clear = function(tableName) {
    return this.server.clear(tableName);
};
MegaDB.prototype.clear = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(MegaDB.prototype.clear),
    'Clear'
);


/**
 * Drop/delete the current database
 *
 * @returns {MegaPromise}
 */
MegaDB.prototype.drop = function() {
    var self = this;
    self.close();
    return self.server.destroy();
};

MegaDB.prototype.drop = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(MegaDB.prototype.drop),
    'Drop'
);


/**
 * Get one object which pk equals to `val` from table `tableName`
 * If the row/object is not found, then the promise will be resolved with 1 argument, which will be empty array
 *
 * @param tableName {String}
 * @param val {Integer}
 * @returns {MegaPromise}
 */
MegaDB.prototype.get = function(tableName, val) {
    var self = this;

    assert(this.server[tableName], 'table not found:' + tableName);

    var promise = new Promise(function(resolve, reject) {

        self.query(tableName)
            .filter("id", val)
            .execute()
            .then(
            function(result) {
                if($.isArray(result) && result.length == 1) {
                    resolve.apply(null, [result[0]]);
                } else if($.isArray(result) && result.length > 1) {
                    resolve.apply(null, [result]);
                }  else {
                    resolve.apply(null, toArray(arguments));
                }

                // resolve with 1 OR multiple arguments please
            },
            function() {
                reject.apply(null, toArray(arguments));
            });
    });
    return promise;
};
MegaDB.prototype.get = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(
        MegaDB.prototype.get
    ),
    'Get'
);


/**
 * Alias to create a new {MegaDB.QuerySet} instance for the target `tableName`
 *
 * @param tableName {String}
 * @returns {MegaDB.QuerySet}
 */
MegaDB.prototype.query = function(tableName) {
    assert(this.schema[tableName], 'table not found:' + tableName);

    return new MegaDB.QuerySet(this, tableName);
};

MegaDB.prototype.query = _wrapFnWithBeforeAndAfterEvents(
    MegaDB.prototype.query,
    'Query',
    true /* does not return a promise, may return false or instance of IndexQuery */
);


/**
 * Close the connection to the DB.
 * Warning: there is no way to re-open a db connection, so after .close is called this MegaDB instance will be useless
 * and throw exceptions/errors in case any of its method get called.
 *
 * @returns {boolean}
 */
MegaDB.prototype.close = function() {
    var self = this;
    self.server.close();


    self.logger.info("Closing db: ", self);

    self.dbState = MegaDB.DB_STATE.CLOSED;

    return true;
};
MegaDB.prototype.close = _wrapFnWithBeforeAndAfterEvents(
    MegaDB._delayFnCallUntilDbReady(
        MegaDB.prototype.close
    ),
    'Close',
    true
);


/**
 * Lazy QuerySet executed helper built ontop of db.js's query API, nothing will happen, until .execute() is called
 *
 * Should be initialized using megaDbInstace.query('tableName').
 *
 * @param megaDb
 * @param tableName
 * @returns {MegaDB.QuerySet}
 * @constructor
 */
MegaDB.QuerySet = function(megaDb, tableName) {
    var self = this;
    self.megaDb = megaDb;
    self.tableName = tableName;
    self.logger = MegaLogger.getLogger("querySet[" + tableName + "]", {}, megaDb.logger);

    self._ops = [];

    'only bound upperBound lowerBound filter all modify map'.split(' ').forEach(function (name) {
        self[name] = function() {
            self._queueOp(name, toArray(arguments));

            return self;
        }
    });

    return this;
};

/**
 * Internal method, for adding MegaDB operations in the internal queue
 *
 * @param opName {String}
 * @param args {Array}
 * @private
 */
MegaDB.QuerySet.prototype._queueOp = function(opName, args) {
    var self = this;
    self._ops.push(
        [opName,  args, false]
    );
};

/**
 * Dequeue all queued operations of a specific type/name
 *
 * @param q {Object} internal db.js queryset object
 * @param opName {String}
 * @returns {Object} internal db.js queryset object
 * @private
 */
MegaDB.QuerySet.prototype._dequeueOps = function(q, opName) {
    var self = this;
    self._ops.forEach(function(v) {
        if(v[2] === true || v[0] != opName) {
            return; // continue;
        }

        var args = v[1];
        if(opName == "filter") {
            args = clone(v[1]);
            self.megaDb.trigger("onFilterQuery", [self.tableName, args]);
        } else if(opName == "modify") {
            args = clone(v[1]);
            self.megaDb.trigger("onModifyQuery", [self.tableName, args]);
        }
        //self.logger.debug("dequeue op:", opName, args);

        // if this was a modify() call, then trigger onBeforeUpdate
        if(opName == "modify") {
            q = q.map(function(r) {
                //self.megaDb.trigger("onBeforeUpdate", [self.tableName, r.id, r, true]);
                return r;
            });
        }

        q = q[opName].apply(q, args);

        v[2] = true; // mark as dequeued
    });
    return q;
};


/**
 * Executes all queued operations and returns a promise, which will be resolved with 1 argument, an Array containing
 * all found results.
 *
 * @returns {MegaPromise}
 */
MegaDB.QuerySet.prototype.execute = MegaDB._delayFnCallUntilDbReady(
    function() {
        var self = this;
        var megaDb = this.megaDb;
        var tableName = self.tableName;

        var q = megaDb.server[tableName].query();

        // dequeue IndexQuery ops first!
        [
            'all',
            'filter',
            'only',
            'bound',
            'upperBound',
            'lowerBound'
        ].forEach(function(opName) {
                q = self._dequeueOps(q, opName);
            });

        if(q.only) { // is instanceof db.js IndexQuery, convert to db.js Query (<- no way to do instanceof, because IndexQuery is PRIVATE :|)
            q = q.all();
        }

        // Query ops
        [
            'distinct',
            'desc',
            'filter',
            'keys',
            'limit'
        ].forEach(function(opName) {
                q = self._dequeueOps(q, opName);
            });


        // by using .map trigger an event when an object is loaded, so that the encryption can kick in and decrypt it
        q = q.map(function(r) {
            var $event = new $.Event("onDbRead");
            megaDb.trigger($event, [tableName, r]);
            if(!$event.isPropagationStopped()) {
                return r;
            } else {
                return undefined;
            }
        });


        // everything else
        q = self._dequeueOps(q, "map");
        q = self._dequeueOps(q, "modify");


        var $proxyPromise = new MegaPromise();

        q.execute()
            .done(function(r) {
                if(r.length > 0) {
                    var results = [];
                    r.forEach(function(v, k) {
                        if(typeof(v) != 'undefined') { // skip undefined, e.g. items removed by .map()
                            results.push(v);
                        }
                    });
                    $proxyPromise.resolve(results);
                } else {
                    $proxyPromise.resolve.apply($proxyPromise, arguments);
                }

            })
            .fail(function() {
                $proxyPromise.reject.apply($proxyPromise, arguments);
            });

        return $proxyPromise;
    }
);