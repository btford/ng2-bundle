'';


function Zone(parentZone, data) {
  var zone = (arguments.length) ? Object.create(parentZone) : this;

  zone.parent = parentZone;

  Object.keys(data || {}).forEach(function(property) {

    var _property = property.substr(1);

    // augment the new zone with a hook decorates the parent's hook
    if (property[0] === '$') {
      zone[_property] = data[property](parentZone[_property] || function () {});

    // augment the new zone with a hook that runs after the parent's hook
    } else if (property[0] === '+') {
      if (parentZone[_property]) {
        zone[_property] = function () {
          var result = parentZone[_property].apply(this, arguments);
          data[property].apply(this, arguments);
          return result;
        };
      } else {
        zone[_property] = data[property];
      }

    // augment the new zone with a hook that runs before the parent's hook
    } else if (property[0] === '-') {
      if (parentZone[_property]) {
        zone[_property] = function () {
          data[property].apply(this, arguments);
          return parentZone[_property].apply(this, arguments);
        };
      } else {
        zone[_property] = data[property];
      }

    // set the new zone's hook (replacing the parent zone's)
    } else {
      zone[property] = (typeof data[property] === 'object') ?
                        JSON.parse(JSON.stringify(data[property])) :
                        data[property];
    }
  });

  zone.$id = ++Zone.nextId;

  return zone;
}


Zone.prototype = {
  constructor: Zone,

  fork: function (locals) {
    this.onZoneCreated();
    return new Zone(this, locals);
  },

  bind: function (fn, skipEnqueue) {
    skipEnqueue || this.enqueueTask(fn);
    var zone = this.fork();
    return function zoneBoundFn() {
      return zone.run(fn, this, arguments);
    };
  },

  bindOnce: function (fn) {
    var boundZone = this;
    return this.bind(function () {
      var result = fn.apply(this, arguments);
      boundZone.dequeueTask(fn);
      return result;
    });
  },

  run: function run (fn, applyTo, applyWith) {
    applyWith = applyWith || [];

    var oldZone = window.zone,
        result;

    window.zone = this;

    try {
      this.beforeTask();
      result = fn.apply(applyTo, applyWith);
    } catch (e) {
      if (zone.onError) {
        zone.onError(e);
      } else {
        throw e;
      }
    } finally {
      this.afterTask();
      window.zone = oldZone;
    }
    return result;
  },

  beforeTask: function () {},
  onZoneCreated: function () {},
  afterTask: function () {},
  enqueueTask: function () {},
  dequeueTask: function () {}
};


Zone.patchSetClearFn = function (obj, fnNames) {
  fnNames.map(function (name) {
    return name[0].toUpperCase() + name.substr(1);
  }).
  forEach(function (name) {
    var setName = 'set' + name;
    var delegate = obj[setName];

    if (delegate) {
      var clearName = 'clear' + name;
      var ids = {};

      var bindArgs = setName === 'setInterval' ? Zone.bindArguments : Zone.bindArgumentsOnce;

      zone[setName] = function (fn) {
        var id;
        arguments[0] = function () {
          delete ids[id];
          return fn.apply(this, arguments);
        };
        var args = bindArgs(arguments);
        id = delegate.apply(obj, args);
        ids[id] = true;
        return id;
      };

      obj[setName] = function () {
        return zone[setName].apply(this, arguments);
      };

      var clearDelegate = obj[clearName];

      zone[clearName] = function (id) {
        if (ids[id]) {
          delete ids[id];
          zone.dequeueTask();
        }
        return clearDelegate.apply(this, arguments);
      };

      obj[clearName] = function () {
        return zone[clearName].apply(this, arguments);
      };
    }
  });
};

Zone.nextId = 1;


Zone.patchSetFn = function (obj, fnNames) {
  fnNames.forEach(function (name) {
    var delegate = obj[name];

    if (delegate) {
      zone[name] = function (fn) {
        arguments[0] = function () {
          return fn.apply(this, arguments);
        };
        var args = Zone.bindArgumentsOnce(arguments);
        return delegate.apply(obj, args);
      };

      obj[name] = function () {
        return zone[name].apply(this, arguments);
      };
    }
  });
};

Zone.patchPrototype = function (obj, fnNames) {
  fnNames.forEach(function (name) {
    var delegate = obj[name];
    if (delegate) {
      obj[name] = function () {
        return delegate.apply(this, Zone.bindArguments(arguments));
      };
    }
  });
};

Zone.bindArguments = function (args) {
  for (var i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') {
      args[i] = zone.bind(args[i]);
    }
  }
  return args;
};


Zone.bindArgumentsOnce = function (args) {
  for (var i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') {
      args[i] = zone.bindOnce(args[i]);
    }
  }
  return args;
};

/*
 * patch a fn that returns a promise
 */
Zone.bindPromiseFn = (function() {
  // if the browser natively supports Promises, we can just return a native promise
  if (window.Promise) {
    return function (delegate) {
      return function() {
        var delegatePromise = delegate.apply(this, arguments);
        if (delegatePromise instanceof Promise) {
          return delegatePromise;
        } else {
          return new Promise(function(resolve, reject) {
            delegatePromise.then(resolve, reject);
          });
        }
      };
    };
  } else {
    // if the browser does not have native promises, we have to patch each promise instance
    return function (delegate) {
      return function () {
        return patchThenable(delegate.apply(this, arguments));
      };
    };
  }

  function patchThenable(thenable) {
    var then = thenable.then;
    thenable.then = function () {
      var args = Zone.bindArguments(arguments);
      var nextThenable = then.apply(thenable, args);
      return patchThenable(nextThenable);
    };

    var ocatch = thenable.catch;
    thenable.catch = function () {
      var args = Zone.bindArguments(arguments);
      var nextThenable = ocatch.apply(thenable, args);
      return patchThenable(nextThenable);
    };
    return thenable;
  }
}());


Zone.patchableFn = function (obj, fnNames) {
  fnNames.forEach(function (name) {
    var delegate = obj[name];
    zone[name] = function () {
      return delegate.apply(obj, arguments);
    };

    obj[name] = function () {
      return zone[name].apply(this, arguments);
    };
  });
};

Zone.patchProperty = function (obj, prop) {
  var desc = Object.getOwnPropertyDescriptor(obj, prop) || {
    enumerable: true,
    configurable: true
  };

  // A property descriptor cannot have getter/setter and be writable
  // deleting the writable and value properties avoids this error:
  //
  // TypeError: property descriptors must not specify a value or be writable when a
  // getter or setter has been specified
  delete desc.writable;
  delete desc.value;

  // substr(2) cuz 'onclick' -> 'click', etc
  var eventName = prop.substr(2);
  var _prop = '_' + prop;

  desc.set = function (fn) {
    if (this[_prop]) {
      this.removeEventListener(eventName, this[_prop]);
    }

    if (typeof fn === 'function') {
      this[_prop] = fn;
      this.addEventListener(eventName, fn, false);
    } else {
      this[_prop] = null;
    }
  };

  desc.get = function () {
    return this[_prop];
  };

  Object.defineProperty(obj, prop, desc);
};

Zone.patchProperties = function (obj, properties) {

  (properties || (function () {
      var props = [];
      for (var prop in obj) {
        props.push(prop);
      }
      return props;
    }()).
    filter(function (propertyName) {
      return propertyName.substr(0,2) === 'on';
    })).
    forEach(function (eventName) {
      Zone.patchProperty(obj, eventName);
    });
};

Zone.patchEventTargetMethods = function (obj) {
  var addDelegate = obj.addEventListener;
  obj.addEventListener = function (eventName, fn) {
    arguments[1] = fn._bound = zone.bind(fn);
    return addDelegate.apply(this, arguments);
  };

  var removeDelegate = obj.removeEventListener;
  obj.removeEventListener = function (eventName, fn) {
    arguments[1] = arguments[1]._bound || arguments[1];
    var result = removeDelegate.apply(this, arguments);
    zone.dequeueTask(fn);
    return result;
  };
};

Zone.patch = function patch () {
  Zone.patchSetClearFn(window, [
    'timeout',
    'interval',
    'immediate'
  ]);

  Zone.patchSetFn(window, [
    'requestAnimationFrame',
    'mozRequestAnimationFrame',
    'webkitRequestAnimationFrame'
  ]);

  Zone.patchableFn(window, ['alert', 'prompt']);

  // patched properties depend on addEventListener, so this needs to come first
  if (window.EventTarget) {
    Zone.patchEventTargetMethods(window.EventTarget.prototype);

  // Note: EventTarget is not available in all browsers,
  // if it's not available, we instead patch the APIs in the IDL that inherit from EventTarget
  } else {
    [ 'ApplicationCache',
      'EventSource',
      'FileReader',
      'InputMethodContext',
      'MediaController',
      'MessagePort',
      'Node',
      'Performance',
      'SVGElementInstance',
      'SharedWorker',
      'TextTrack',
      'TextTrackCue',
      'TextTrackList',
      'WebKitNamedFlow',
      'Window',
      'Worker',
      'WorkerGlobalScope',
      'XMLHttpRequestEventTarget',
      'XMLHttpRequestUpload'
    ].
    filter(function (thing) {
      return window[thing];
    }).
    map(function (thing) {
      return window[thing].prototype;
    }).
    forEach(Zone.patchEventTargetMethods);
  }

  if (Zone.canPatchViaPropertyDescriptor()) {
    Zone.patchViaPropertyDescriptor();
  } else {
    Zone.patchViaCapturingAllTheEvents();
    Zone.patchClass('XMLHttpRequest');
    Zone.patchWebSocket();
  }

  // patch promises
  if (window.Promise) {
    Zone.patchPrototype(Promise.prototype, [
      'then',
      'catch'
    ]);
  }
  Zone.patchMutationObserverClass('MutationObserver');
  Zone.patchMutationObserverClass('WebKitMutationObserver');
  Zone.patchDefineProperty();
  Zone.patchRegisterElement();
};

//
Zone.canPatchViaPropertyDescriptor = function () {
  if (!Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'onclick') &&
      typeof Element !== 'undefined') {
    // WebKit https://bugs.webkit.org/show_bug.cgi?id=134364
    // IDL interface attributes are not configurable
    var desc = Object.getOwnPropertyDescriptor(Element.prototype, 'onclick');
    if (desc && !desc.configurable) return false;
  }

  Object.defineProperty(HTMLElement.prototype, 'onclick', {
    get: function () {
      return true;
    }
  });
  var elt = document.createElement('div');
  var result = !!elt.onclick;
  Object.defineProperty(HTMLElement.prototype, 'onclick', {});
  return result;
};

// for browsers that we can patch the descriptor:
// - eventually Chrome once this bug gets resolved
// - Firefox
Zone.patchViaPropertyDescriptor = function () {
  Zone.patchProperties(HTMLElement.prototype, Zone.onEventNames);
  Zone.patchProperties(XMLHttpRequest.prototype);
};

// Whenever any event fires, we check the event target and all parents
// for `onwhatever` properties and replace them with zone-bound functions
// - Chrome (for now)
Zone.patchViaCapturingAllTheEvents = function () {
  Zone.eventNames.forEach(function (property) {
    var onproperty = 'on' + property;
    document.addEventListener(property, function (event) {
      var elt = event.target, bound;
      while (elt) {
        if (elt[onproperty] && !elt[onproperty]._unbound) {
          bound = zone.bind(elt[onproperty]);
          bound._unbound = elt[onproperty];
          elt[onproperty] = bound;
        }
        elt = elt.parentElement;
      }
    }, true);
  });
};

// we have to patch the instance since the proto is non-configurable
Zone.patchWebSocket = function() {
  var WS = window.WebSocket;
  window.WebSocket = function(a, b) {
    var socket = arguments.length > 1 ? new WS(a, b) : new WS(a);
    Zone.patchProperties(socket, ['onclose', 'onerror', 'onmessage', 'onopen']);
    return socket;
  };
}


// wrap some native API on `window`
Zone.patchClass = function (className) {
  var OriginalClass = window[className];
  if (!OriginalClass) {
    return;
  }
  window[className] = function () {
    var a = Zone.bindArguments(arguments);
    switch (a.length) {
      case 0: this._o = new OriginalClass(); break;
      case 1: this._o = new OriginalClass(a[0]); break;
      case 2: this._o = new OriginalClass(a[0], a[1]); break;
      case 3: this._o = new OriginalClass(a[0], a[1], a[2]); break;
      case 4: this._o = new OriginalClass(a[0], a[1], a[2], a[3]); break;
      default: throw new Error('what are you even doing?');
    }
  };

  var instance = new OriginalClass(className.substr(-16) === 'MutationObserver' ? function () {} : undefined);

  var prop;
  for (prop in instance) {
    (function (prop) {
      if (typeof instance[prop] === 'function') {
        window[className].prototype[prop] = function () {
          return this._o[prop].apply(this._o, arguments);
        };
      } else {
        Object.defineProperty(window[className].prototype, prop, {
          set: function (fn) {
            if (typeof fn === 'function') {
              this._o[prop] = zone.bind(fn);
            } else {
              this._o[prop] = fn;
            }
          },
          get: function () {
            return this._o[prop];
          }
        });
      }
    }(prop));
  };
};


// wrap some native API on `window`
Zone.patchMutationObserverClass = function (className) {
  var OriginalClass = window[className];
  if (!OriginalClass) {
    return;
  }
  window[className] = function (fn) {
    this._o = new OriginalClass(zone.bind(fn, true));
  };

  var instance = new OriginalClass(function () {});

  window[className].prototype.disconnect = function () {
    var result = this._o.disconnect.apply(this._o, arguments);
    this._active && zone.dequeueTask();
    this._active = false;
    return result;
  };

  window[className].prototype.observe = function () {
    if (!this._active) {
      zone.enqueueTask();
    }
    this._active = true;
    return this._o.observe.apply(this._o, arguments);
  };

  var prop;
  for (prop in instance) {
    (function (prop) {
      if (typeof window[className].prototype !== undefined) {
        return;
      }
      if (typeof instance[prop] === 'function') {
        window[className].prototype[prop] = function () {
          return this._o[prop].apply(this._o, arguments);
        };
      } else {
        Object.defineProperty(window[className].prototype, prop, {
          set: function (fn) {
            if (typeof fn === 'function') {
              this._o[prop] = zone.bind(fn);
            } else {
              this._o[prop] = fn;
            }
          },
          get: function () {
            return this._o[prop];
          }
        });
      }
    }(prop));
  }
};

// might need similar for object.freeze
// i regret nothing
Zone.patchDefineProperty = function () {
  var _defineProperty = Object.defineProperty;
  var _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var _create = Object.create;

  Object.defineProperty = function (obj, prop, desc) {
    if (isUnconfigurable(obj, prop)) {
      throw new TypeError('Cannot assign to read only property \'' + prop + '\' of ' + obj);
    }
    if (prop !== 'prototype') {
      desc = rewriteDescriptor(obj, prop, desc);
    }
    return _defineProperty(obj, prop, desc);
  };

  Object.defineProperties = function (obj, props) {
    Object.keys(props).forEach(function (prop) {
      Object.defineProperty(obj, prop, props[prop]);
    });
    return obj;
  };

  Object.create = function (obj, proto) {
    if (typeof proto === 'object') {
      Object.keys(proto).forEach(function (prop) {
        proto[prop] = rewriteDescriptor(obj, prop, proto[prop]);
      });
    }
    return _create(obj, proto);
  };

  Object.getOwnPropertyDescriptor = function (obj, prop) {
    var desc = _getOwnPropertyDescriptor(obj, prop);
    if (isUnconfigurable(obj, prop)) {
      desc.configurable = false;
    }
    return desc;
  };

  Zone._redefineProperty = function (obj, prop, desc) {
    desc = rewriteDescriptor(obj, prop, desc);
    return _defineProperty(obj, prop, desc);
  };

  function isUnconfigurable (obj, prop) {
    return obj && obj.__unconfigurables && obj.__unconfigurables[prop];
  }

  function rewriteDescriptor (obj, prop, desc) {
    desc.configurable = true;
    if (!desc.configurable) {
      if (!obj.__unconfigurables) {
        _defineProperty(obj, '__unconfigurables', { writable: true, value: {} });
      }
      obj.__unconfigurables[prop] = true;
    }
    return desc;
  }
};

Zone.patchRegisterElement = function () {
  if (!('registerElement' in document)) {
    return;
  }
  var _registerElement = document.registerElement;
  var callbacks = [
    'createdCallback',
    'attachedCallback',
    'detachedCallback',
    'attributeChangedCallback'
  ];
  document.registerElement = function (name, opts) {
    callbacks.forEach(function (callback) {
      if (opts.prototype[callback]) {
        var descriptor = Object.getOwnPropertyDescriptor(opts.prototype, callback);
        if (descriptor.value) {
          descriptor.value = zone.bind(descriptor.value || opts.prototype[callback]);
          Zone._redefineProperty(opts.prototype, callback, descriptor);
        }
      }
    });
    return _registerElement.apply(document, [name, opts]);
  };
}

Zone.eventNames = 'copy cut paste abort blur focus canplay canplaythrough change click contextmenu dblclick drag dragend dragenter dragleave dragover dragstart drop durationchange emptied ended input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart message mousedown mouseenter mouseleave mousemove mouseout mouseover mouseup pause play playing progress ratechange reset scroll seeked seeking select show stalled submit suspend timeupdate volumechange waiting mozfullscreenchange mozfullscreenerror mozpointerlockchange mozpointerlockerror error webglcontextrestored webglcontextlost webglcontextcreationerror'.split(' ');
Zone.onEventNames = Zone.eventNames.map(function (property) {
  return 'on' + property;
});

Zone.init = function init () {
  if (typeof module !== 'undefined' && module && module.exports) {
    module.exports = new Zone();
  } else {
    window.zone = new Zone();
  }
  Zone.patch();
};


Zone.init();

"format register";
(function() {
function define(){};  define.amd = {};
;
(function(undefined) {
  var objectTypes = {
    'boolean': false,
    'function': true,
    'object': true,
    'number': false,
    'string': false,
    'undefined': false
  };
  var root = (objectTypes[typeof window] && window) || this,
      freeExports = objectTypes[typeof exports] && exports && !exports.nodeType && exports,
      freeModule = objectTypes[typeof module] && module && !module.nodeType && module,
      moduleExports = freeModule && freeModule.exports === freeExports && freeExports,
      freeGlobal = objectTypes[typeof global] && global;
  if (freeGlobal && (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal)) {
    root = freeGlobal;
  }
  var Rx = {
    internals: {},
    config: {Promise: root.Promise},
    helpers: {}
  };
  var noop = Rx.helpers.noop = function() {},
      notDefined = Rx.helpers.notDefined = function(x) {
        return typeof x === 'undefined';
      },
      isScheduler = Rx.helpers.isScheduler = function(x) {
        return x instanceof Rx.Scheduler;
      },
      identity = Rx.helpers.identity = function(x) {
        return x;
      },
      pluck = Rx.helpers.pluck = function(property) {
        return function(x) {
          return x[property];
        };
      },
      just = Rx.helpers.just = function(value) {
        return function() {
          return value;
        };
      },
      defaultNow = Rx.helpers.defaultNow = Date.now,
      defaultComparer = Rx.helpers.defaultComparer = function(x, y) {
        return isEqual(x, y);
      },
      defaultSubComparer = Rx.helpers.defaultSubComparer = function(x, y) {
        return x > y ? 1 : (x < y ? -1 : 0);
      },
      defaultKeySerializer = Rx.helpers.defaultKeySerializer = function(x) {
        return x.toString();
      },
      defaultError = Rx.helpers.defaultError = function(err) {
        throw err;
      },
      isPromise = Rx.helpers.isPromise = function(p) {
        return !!p && typeof p.then === 'function';
      },
      asArray = Rx.helpers.asArray = function() {
        return Array.prototype.slice.call(arguments);
      },
      not = Rx.helpers.not = function(a) {
        return !a;
      },
      isFunction = Rx.helpers.isFunction = (function() {
        var isFn = function(value) {
          return typeof value == 'function' || false;
        };
        if (isFn(/x/)) {
          isFn = function(value) {
            return typeof value == 'function' && toString.call(value) == '[object Function]';
          };
        }
        return isFn;
      }());
  function cloneArray(arr) {
    for (var a = [],
        i = 0,
        len = arr.length; i < len; i++) {
      a.push(arr[i]);
    }
    return a;
  }
  Rx.config.longStackSupport = false;
  var hasStacks = false;
  try {
    throw new Error();
  } catch (e) {
    hasStacks = !!e.stack;
  }
  var rStartingLine = captureLine(),
      rFileName;
  var STACK_JUMP_SEPARATOR = "From previous event:";
  function makeStackTraceLong(error, observable) {
    if (hasStacks && observable.stack && typeof error === "object" && error !== null && error.stack && error.stack.indexOf(STACK_JUMP_SEPARATOR) === -1) {
      var stacks = [];
      for (var o = observable; !!o; o = o.source) {
        if (o.stack) {
          stacks.unshift(o.stack);
        }
      }
      stacks.unshift(error.stack);
      var concatedStacks = stacks.join("\n" + STACK_JUMP_SEPARATOR + "\n");
      error.stack = filterStackString(concatedStacks);
    }
  }
  function filterStackString(stackString) {
    var lines = stackString.split("\n"),
        desiredLines = [];
    for (var i = 0,
        len = lines.length; i < len; i++) {
      var line = lines[i];
      if (!isInternalFrame(line) && !isNodeFrame(line) && line) {
        desiredLines.push(line);
      }
    }
    return desiredLines.join("\n");
  }
  function isInternalFrame(stackLine) {
    var fileNameAndLineNumber = getFileNameAndLineNumber(stackLine);
    if (!fileNameAndLineNumber) {
      return false;
    }
    var fileName = fileNameAndLineNumber[0],
        lineNumber = fileNameAndLineNumber[1];
    return fileName === rFileName && lineNumber >= rStartingLine && lineNumber <= rEndingLine;
  }
  function isNodeFrame(stackLine) {
    return stackLine.indexOf("(module.js:") !== -1 || stackLine.indexOf("(node.js:") !== -1;
  }
  function captureLine() {
    if (!hasStacks) {
      return ;
    }
    try {
      throw new Error();
    } catch (e) {
      var lines = e.stack.split("\n");
      var firstLine = lines[0].indexOf("@") > 0 ? lines[1] : lines[2];
      var fileNameAndLineNumber = getFileNameAndLineNumber(firstLine);
      if (!fileNameAndLineNumber) {
        return ;
      }
      rFileName = fileNameAndLineNumber[0];
      return fileNameAndLineNumber[1];
    }
  }
  function getFileNameAndLineNumber(stackLine) {
    var attempt1 = /at .+ \((.+):(\d+):(?:\d+)\)$/.exec(stackLine);
    if (attempt1) {
      return [attempt1[1], Number(attempt1[2])];
    }
    var attempt2 = /at ([^ ]+):(\d+):(?:\d+)$/.exec(stackLine);
    if (attempt2) {
      return [attempt2[1], Number(attempt2[2])];
    }
    var attempt3 = /.*@(.+):(\d+)$/.exec(stackLine);
    if (attempt3) {
      return [attempt3[1], Number(attempt3[2])];
    }
  }
  var EmptyError = Rx.EmptyError = function() {
    this.message = 'Sequence contains no elements.';
    Error.call(this);
  };
  EmptyError.prototype = Error.prototype;
  var ObjectDisposedError = Rx.ObjectDisposedError = function() {
    this.message = 'Object has been disposed';
    Error.call(this);
  };
  ObjectDisposedError.prototype = Error.prototype;
  var ArgumentOutOfRangeError = Rx.ArgumentOutOfRangeError = function() {
    this.message = 'Argument out of range';
    Error.call(this);
  };
  ArgumentOutOfRangeError.prototype = Error.prototype;
  var NotSupportedError = Rx.NotSupportedError = function(message) {
    this.message = message || 'This operation is not supported';
    Error.call(this);
  };
  NotSupportedError.prototype = Error.prototype;
  var NotImplementedError = Rx.NotImplementedError = function(message) {
    this.message = message || 'This operation is not implemented';
    Error.call(this);
  };
  NotImplementedError.prototype = Error.prototype;
  var notImplemented = Rx.helpers.notImplemented = function() {
    throw new NotImplementedError();
  };
  var notSupported = Rx.helpers.notSupported = function() {
    throw new NotSupportedError();
  };
  var $iterator$ = (typeof Symbol === 'function' && Symbol.iterator) || '_es6shim_iterator_';
  if (root.Set && typeof new root.Set()['@@iterator'] === 'function') {
    $iterator$ = '@@iterator';
  }
  var doneEnumerator = Rx.doneEnumerator = {
    done: true,
    value: undefined
  };
  var isIterable = Rx.helpers.isIterable = function(o) {
    return o[$iterator$] !== undefined;
  };
  var isArrayLike = Rx.helpers.isArrayLike = function(o) {
    return o && o.length !== undefined;
  };
  Rx.helpers.iterator = $iterator$;
  var bindCallback = Rx.internals.bindCallback = function(func, thisArg, argCount) {
    if (typeof thisArg === 'undefined') {
      return func;
    }
    switch (argCount) {
      case 0:
        return function() {
          return func.call(thisArg);
        };
      case 1:
        return function(arg) {
          return func.call(thisArg, arg);
        };
      case 2:
        return function(value, index) {
          return func.call(thisArg, value, index);
        };
      case 3:
        return function(value, index, collection) {
          return func.call(thisArg, value, index, collection);
        };
    }
    return function() {
      return func.apply(thisArg, arguments);
    };
  };
  var dontEnums = ['toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'constructor'],
      dontEnumsLength = dontEnums.length;
  var argsClass = '[object Arguments]',
      arrayClass = '[object Array]',
      boolClass = '[object Boolean]',
      dateClass = '[object Date]',
      errorClass = '[object Error]',
      funcClass = '[object Function]',
      numberClass = '[object Number]',
      objectClass = '[object Object]',
      regexpClass = '[object RegExp]',
      stringClass = '[object String]';
  var toString = Object.prototype.toString,
      hasOwnProperty = Object.prototype.hasOwnProperty,
      supportsArgsClass = toString.call(arguments) == argsClass,
      supportNodeClass,
      errorProto = Error.prototype,
      objectProto = Object.prototype,
      stringProto = String.prototype,
      propertyIsEnumerable = objectProto.propertyIsEnumerable;
  try {
    supportNodeClass = !(toString.call(document) == objectClass && !({'toString': 0} + ''));
  } catch (e) {
    supportNodeClass = true;
  }
  var nonEnumProps = {};
  nonEnumProps[arrayClass] = nonEnumProps[dateClass] = nonEnumProps[numberClass] = {
    'constructor': true,
    'toLocaleString': true,
    'toString': true,
    'valueOf': true
  };
  nonEnumProps[boolClass] = nonEnumProps[stringClass] = {
    'constructor': true,
    'toString': true,
    'valueOf': true
  };
  nonEnumProps[errorClass] = nonEnumProps[funcClass] = nonEnumProps[regexpClass] = {
    'constructor': true,
    'toString': true
  };
  nonEnumProps[objectClass] = {'constructor': true};
  var support = {};
  (function() {
    var ctor = function() {
      this.x = 1;
    },
        props = [];
    ctor.prototype = {
      'valueOf': 1,
      'y': 1
    };
    for (var key in new ctor) {
      props.push(key);
    }
    for (key in arguments) {}
    support.enumErrorProps = propertyIsEnumerable.call(errorProto, 'message') || propertyIsEnumerable.call(errorProto, 'name');
    support.enumPrototypes = propertyIsEnumerable.call(ctor, 'prototype');
    support.nonEnumArgs = key != 0;
    support.nonEnumShadows = !/valueOf/.test(props);
  }(1));
  var isObject = Rx.internals.isObject = function(value) {
    var type = typeof value;
    return value && (type == 'function' || type == 'object') || false;
  };
  function keysIn(object) {
    var result = [];
    if (!isObject(object)) {
      return result;
    }
    if (support.nonEnumArgs && object.length && isArguments(object)) {
      object = slice.call(object);
    }
    var skipProto = support.enumPrototypes && typeof object == 'function',
        skipErrorProps = support.enumErrorProps && (object === errorProto || object instanceof Error);
    for (var key in object) {
      if (!(skipProto && key == 'prototype') && !(skipErrorProps && (key == 'message' || key == 'name'))) {
        result.push(key);
      }
    }
    if (support.nonEnumShadows && object !== objectProto) {
      var ctor = object.constructor,
          index = -1,
          length = dontEnumsLength;
      if (object === (ctor && ctor.prototype)) {
        var className = object === stringProto ? stringClass : object === errorProto ? errorClass : toString.call(object),
            nonEnum = nonEnumProps[className];
      }
      while (++index < length) {
        key = dontEnums[index];
        if (!(nonEnum && nonEnum[key]) && hasOwnProperty.call(object, key)) {
          result.push(key);
        }
      }
    }
    return result;
  }
  function internalFor(object, callback, keysFunc) {
    var index = -1,
        props = keysFunc(object),
        length = props.length;
    while (++index < length) {
      var key = props[index];
      if (callback(object[key], key, object) === false) {
        break;
      }
    }
    return object;
  }
  function internalForIn(object, callback) {
    return internalFor(object, callback, keysIn);
  }
  function isNode(value) {
    return typeof value.toString != 'function' && typeof(value + '') == 'string';
  }
  var isArguments = function(value) {
    return (value && typeof value == 'object') ? toString.call(value) == argsClass : false;
  };
  if (!supportsArgsClass) {
    isArguments = function(value) {
      return (value && typeof value == 'object') ? hasOwnProperty.call(value, 'callee') : false;
    };
  }
  var isEqual = Rx.internals.isEqual = function(x, y) {
    return deepEquals(x, y, [], []);
  };
  function deepEquals(a, b, stackA, stackB) {
    if (a === b) {
      return a !== 0 || (1 / a == 1 / b);
    }
    var type = typeof a,
        otherType = typeof b;
    if (a === a && (a == null || b == null || (type != 'function' && type != 'object' && otherType != 'function' && otherType != 'object'))) {
      return false;
    }
    var className = toString.call(a),
        otherClass = toString.call(b);
    if (className == argsClass) {
      className = objectClass;
    }
    if (otherClass == argsClass) {
      otherClass = objectClass;
    }
    if (className != otherClass) {
      return false;
    }
    switch (className) {
      case boolClass:
      case dateClass:
        return +a == +b;
      case numberClass:
        return (a != +a) ? b != +b : (a == 0 ? (1 / a == 1 / b) : a == +b);
      case regexpClass:
      case stringClass:
        return a == String(b);
    }
    var isArr = className == arrayClass;
    if (!isArr) {
      if (className != objectClass || (!support.nodeClass && (isNode(a) || isNode(b)))) {
        return false;
      }
      var ctorA = !support.argsObject && isArguments(a) ? Object : a.constructor,
          ctorB = !support.argsObject && isArguments(b) ? Object : b.constructor;
      if (ctorA != ctorB && !(hasOwnProperty.call(a, 'constructor') && hasOwnProperty.call(b, 'constructor')) && !(isFunction(ctorA) && ctorA instanceof ctorA && isFunction(ctorB) && ctorB instanceof ctorB) && ('constructor' in a && 'constructor' in b)) {
        return false;
      }
    }
    var initedStack = !stackA;
    stackA || (stackA = []);
    stackB || (stackB = []);
    var length = stackA.length;
    while (length--) {
      if (stackA[length] == a) {
        return stackB[length] == b;
      }
    }
    var size = 0;
    var result = true;
    stackA.push(a);
    stackB.push(b);
    if (isArr) {
      length = a.length;
      size = b.length;
      result = size == length;
      if (result) {
        while (size--) {
          var index = length,
              value = b[size];
          if (!(result = deepEquals(a[size], value, stackA, stackB))) {
            break;
          }
        }
      }
    } else {
      internalForIn(b, function(value, key, b) {
        if (hasOwnProperty.call(b, key)) {
          size++;
          return (result = hasOwnProperty.call(a, key) && deepEquals(a[key], value, stackA, stackB));
        }
      });
      if (result) {
        internalForIn(a, function(value, key, a) {
          if (hasOwnProperty.call(a, key)) {
            return (result = --size > -1);
          }
        });
      }
    }
    stackA.pop();
    stackB.pop();
    return result;
  }
  var hasProp = {}.hasOwnProperty,
      slice = Array.prototype.slice;
  var inherits = this.inherits = Rx.internals.inherits = function(child, parent) {
    function __() {
      this.constructor = child;
    }
    __.prototype = parent.prototype;
    child.prototype = new __();
  };
  var addProperties = Rx.internals.addProperties = function(obj) {
    for (var sources = [],
        i = 1,
        len = arguments.length; i < len; i++) {
      sources.push(arguments[i]);
    }
    for (var idx = 0,
        ln = sources.length; idx < ln; idx++) {
      var source = sources[idx];
      for (var prop in source) {
        obj[prop] = source[prop];
      }
    }
  };
  var addRef = Rx.internals.addRef = function(xs, r) {
    return new AnonymousObservable(function(observer) {
      return new CompositeDisposable(r.getDisposable(), xs.subscribe(observer));
    });
  };
  function arrayInitialize(count, factory) {
    var a = new Array(count);
    for (var i = 0; i < count; i++) {
      a[i] = factory();
    }
    return a;
  }
  var errorObj = {e: {}};
  var tryCatchTarget;
  function tryCatcher() {
    try {
      return tryCatchTarget.apply(this, arguments);
    } catch (e) {
      errorObj.e = e;
      return errorObj;
    }
  }
  function tryCatch(fn) {
    if (!isFunction(fn)) {
      throw new TypeError('fn must be a function');
    }
    tryCatchTarget = fn;
    return tryCatcher;
  }
  function thrower(e) {
    throw e;
  }
  function IndexedItem(id, value) {
    this.id = id;
    this.value = value;
  }
  IndexedItem.prototype.compareTo = function(other) {
    var c = this.value.compareTo(other.value);
    c === 0 && (c = this.id - other.id);
    return c;
  };
  var PriorityQueue = Rx.internals.PriorityQueue = function(capacity) {
    this.items = new Array(capacity);
    this.length = 0;
  };
  var priorityProto = PriorityQueue.prototype;
  priorityProto.isHigherPriority = function(left, right) {
    return this.items[left].compareTo(this.items[right]) < 0;
  };
  priorityProto.percolate = function(index) {
    if (index >= this.length || index < 0) {
      return ;
    }
    var parent = index - 1 >> 1;
    if (parent < 0 || parent === index) {
      return ;
    }
    if (this.isHigherPriority(index, parent)) {
      var temp = this.items[index];
      this.items[index] = this.items[parent];
      this.items[parent] = temp;
      this.percolate(parent);
    }
  };
  priorityProto.heapify = function(index) {
    +index || (index = 0);
    if (index >= this.length || index < 0) {
      return ;
    }
    var left = 2 * index + 1,
        right = 2 * index + 2,
        first = index;
    if (left < this.length && this.isHigherPriority(left, first)) {
      first = left;
    }
    if (right < this.length && this.isHigherPriority(right, first)) {
      first = right;
    }
    if (first !== index) {
      var temp = this.items[index];
      this.items[index] = this.items[first];
      this.items[first] = temp;
      this.heapify(first);
    }
  };
  priorityProto.peek = function() {
    return this.items[0].value;
  };
  priorityProto.removeAt = function(index) {
    this.items[index] = this.items[--this.length];
    this.items[this.length] = undefined;
    this.heapify();
  };
  priorityProto.dequeue = function() {
    var result = this.peek();
    this.removeAt(0);
    return result;
  };
  priorityProto.enqueue = function(item) {
    var index = this.length++;
    this.items[index] = new IndexedItem(PriorityQueue.count++, item);
    this.percolate(index);
  };
  priorityProto.remove = function(item) {
    for (var i = 0; i < this.length; i++) {
      if (this.items[i].value === item) {
        this.removeAt(i);
        return true;
      }
    }
    return false;
  };
  PriorityQueue.count = 0;
  var CompositeDisposable = Rx.CompositeDisposable = function() {
    var args = [],
        i,
        len;
    if (Array.isArray(arguments[0])) {
      args = arguments[0];
      len = args.length;
    } else {
      len = arguments.length;
      args = new Array(len);
      for (i = 0; i < len; i++) {
        args[i] = arguments[i];
      }
    }
    for (i = 0; i < len; i++) {
      if (!isDisposable(args[i])) {
        throw new TypeError('Not a disposable');
      }
    }
    this.disposables = args;
    this.isDisposed = false;
    this.length = args.length;
  };
  var CompositeDisposablePrototype = CompositeDisposable.prototype;
  CompositeDisposablePrototype.add = function(item) {
    if (this.isDisposed) {
      item.dispose();
    } else {
      this.disposables.push(item);
      this.length++;
    }
  };
  CompositeDisposablePrototype.remove = function(item) {
    var shouldDispose = false;
    if (!this.isDisposed) {
      var idx = this.disposables.indexOf(item);
      if (idx !== -1) {
        shouldDispose = true;
        this.disposables.splice(idx, 1);
        this.length--;
        item.dispose();
      }
    }
    return shouldDispose;
  };
  CompositeDisposablePrototype.dispose = function() {
    if (!this.isDisposed) {
      this.isDisposed = true;
      var len = this.disposables.length,
          currentDisposables = new Array(len);
      for (var i = 0; i < len; i++) {
        currentDisposables[i] = this.disposables[i];
      }
      this.disposables = [];
      this.length = 0;
      for (i = 0; i < len; i++) {
        currentDisposables[i].dispose();
      }
    }
  };
  var Disposable = Rx.Disposable = function(action) {
    this.isDisposed = false;
    this.action = action || noop;
  };
  Disposable.prototype.dispose = function() {
    if (!this.isDisposed) {
      this.action();
      this.isDisposed = true;
    }
  };
  var disposableCreate = Disposable.create = function(action) {
    return new Disposable(action);
  };
  var disposableEmpty = Disposable.empty = {dispose: noop};
  var isDisposable = Disposable.isDisposable = function(d) {
    return d && isFunction(d.dispose);
  };
  var checkDisposed = Disposable.checkDisposed = function(disposable) {
    if (disposable.isDisposed) {
      throw new ObjectDisposedError();
    }
  };
  var SingleAssignmentDisposable = Rx.SingleAssignmentDisposable = (function() {
    function BooleanDisposable() {
      this.isDisposed = false;
      this.current = null;
    }
    var booleanDisposablePrototype = BooleanDisposable.prototype;
    booleanDisposablePrototype.getDisposable = function() {
      return this.current;
    };
    booleanDisposablePrototype.setDisposable = function(value) {
      var shouldDispose = this.isDisposed;
      if (!shouldDispose) {
        var old = this.current;
        this.current = value;
      }
      old && old.dispose();
      shouldDispose && value && value.dispose();
    };
    booleanDisposablePrototype.dispose = function() {
      if (!this.isDisposed) {
        this.isDisposed = true;
        var old = this.current;
        this.current = null;
      }
      old && old.dispose();
    };
    return BooleanDisposable;
  }());
  var SerialDisposable = Rx.SerialDisposable = SingleAssignmentDisposable;
  var RefCountDisposable = Rx.RefCountDisposable = (function() {
    function InnerDisposable(disposable) {
      this.disposable = disposable;
      this.disposable.count++;
      this.isInnerDisposed = false;
    }
    InnerDisposable.prototype.dispose = function() {
      if (!this.disposable.isDisposed && !this.isInnerDisposed) {
        this.isInnerDisposed = true;
        this.disposable.count--;
        if (this.disposable.count === 0 && this.disposable.isPrimaryDisposed) {
          this.disposable.isDisposed = true;
          this.disposable.underlyingDisposable.dispose();
        }
      }
    };
    function RefCountDisposable(disposable) {
      this.underlyingDisposable = disposable;
      this.isDisposed = false;
      this.isPrimaryDisposed = false;
      this.count = 0;
    }
    RefCountDisposable.prototype.dispose = function() {
      if (!this.isDisposed && !this.isPrimaryDisposed) {
        this.isPrimaryDisposed = true;
        if (this.count === 0) {
          this.isDisposed = true;
          this.underlyingDisposable.dispose();
        }
      }
    };
    RefCountDisposable.prototype.getDisposable = function() {
      return this.isDisposed ? disposableEmpty : new InnerDisposable(this);
    };
    return RefCountDisposable;
  })();
  function ScheduledDisposable(scheduler, disposable) {
    this.scheduler = scheduler;
    this.disposable = disposable;
    this.isDisposed = false;
  }
  function scheduleItem(s, self) {
    if (!self.isDisposed) {
      self.isDisposed = true;
      self.disposable.dispose();
    }
  }
  ScheduledDisposable.prototype.dispose = function() {
    this.scheduler.scheduleWithState(this, scheduleItem);
  };
  var ScheduledItem = Rx.internals.ScheduledItem = function(scheduler, state, action, dueTime, comparer) {
    this.scheduler = scheduler;
    this.state = state;
    this.action = action;
    this.dueTime = dueTime;
    this.comparer = comparer || defaultSubComparer;
    this.disposable = new SingleAssignmentDisposable();
  };
  ScheduledItem.prototype.invoke = function() {
    this.disposable.setDisposable(this.invokeCore());
  };
  ScheduledItem.prototype.compareTo = function(other) {
    return this.comparer(this.dueTime, other.dueTime);
  };
  ScheduledItem.prototype.isCancelled = function() {
    return this.disposable.isDisposed;
  };
  ScheduledItem.prototype.invokeCore = function() {
    return this.action(this.scheduler, this.state);
  };
  var Scheduler = Rx.Scheduler = (function() {
    function Scheduler(now, schedule, scheduleRelative, scheduleAbsolute) {
      this.now = now;
      this._schedule = schedule;
      this._scheduleRelative = scheduleRelative;
      this._scheduleAbsolute = scheduleAbsolute;
    }
    function invokeAction(scheduler, action) {
      action();
      return disposableEmpty;
    }
    var schedulerProto = Scheduler.prototype;
    schedulerProto.schedule = function(action) {
      return this._schedule(action, invokeAction);
    };
    schedulerProto.scheduleWithState = function(state, action) {
      return this._schedule(state, action);
    };
    schedulerProto.scheduleWithRelative = function(dueTime, action) {
      return this._scheduleRelative(action, dueTime, invokeAction);
    };
    schedulerProto.scheduleWithRelativeAndState = function(state, dueTime, action) {
      return this._scheduleRelative(state, dueTime, action);
    };
    schedulerProto.scheduleWithAbsolute = function(dueTime, action) {
      return this._scheduleAbsolute(action, dueTime, invokeAction);
    };
    schedulerProto.scheduleWithAbsoluteAndState = function(state, dueTime, action) {
      return this._scheduleAbsolute(state, dueTime, action);
    };
    Scheduler.now = defaultNow;
    Scheduler.normalize = function(timeSpan) {
      timeSpan < 0 && (timeSpan = 0);
      return timeSpan;
    };
    return Scheduler;
  }());
  var normalizeTime = Scheduler.normalize;
  (function(schedulerProto) {
    function invokeRecImmediate(scheduler, pair) {
      var state = pair[0],
          action = pair[1],
          group = new CompositeDisposable();
      function recursiveAction(state1) {
        action(state1, function(state2) {
          var isAdded = false,
              isDone = false,
              d = scheduler.scheduleWithState(state2, function(scheduler1, state3) {
                if (isAdded) {
                  group.remove(d);
                } else {
                  isDone = true;
                }
                recursiveAction(state3);
                return disposableEmpty;
              });
          if (!isDone) {
            group.add(d);
            isAdded = true;
          }
        });
      }
      recursiveAction(state);
      return group;
    }
    function invokeRecDate(scheduler, pair, method) {
      var state = pair[0],
          action = pair[1],
          group = new CompositeDisposable();
      function recursiveAction(state1) {
        action(state1, function(state2, dueTime1) {
          var isAdded = false,
              isDone = false,
              d = scheduler[method](state2, dueTime1, function(scheduler1, state3) {
                if (isAdded) {
                  group.remove(d);
                } else {
                  isDone = true;
                }
                recursiveAction(state3);
                return disposableEmpty;
              });
          if (!isDone) {
            group.add(d);
            isAdded = true;
          }
        });
      }
      ;
      recursiveAction(state);
      return group;
    }
    function scheduleInnerRecursive(action, self) {
      action(function(dt) {
        self(action, dt);
      });
    }
    schedulerProto.scheduleRecursive = function(action) {
      return this.scheduleRecursiveWithState(action, function(_action, self) {
        _action(function() {
          self(_action);
        });
      });
    };
    schedulerProto.scheduleRecursiveWithState = function(state, action) {
      return this.scheduleWithState([state, action], invokeRecImmediate);
    };
    schedulerProto.scheduleRecursiveWithRelative = function(dueTime, action) {
      return this.scheduleRecursiveWithRelativeAndState(action, dueTime, scheduleInnerRecursive);
    };
    schedulerProto.scheduleRecursiveWithRelativeAndState = function(state, dueTime, action) {
      return this._scheduleRelative([state, action], dueTime, function(s, p) {
        return invokeRecDate(s, p, 'scheduleWithRelativeAndState');
      });
    };
    schedulerProto.scheduleRecursiveWithAbsolute = function(dueTime, action) {
      return this.scheduleRecursiveWithAbsoluteAndState(action, dueTime, scheduleInnerRecursive);
    };
    schedulerProto.scheduleRecursiveWithAbsoluteAndState = function(state, dueTime, action) {
      return this._scheduleAbsolute([state, action], dueTime, function(s, p) {
        return invokeRecDate(s, p, 'scheduleWithAbsoluteAndState');
      });
    };
  }(Scheduler.prototype));
  (function(schedulerProto) {
    Scheduler.prototype.schedulePeriodic = function(period, action) {
      return this.schedulePeriodicWithState(null, period, action);
    };
    Scheduler.prototype.schedulePeriodicWithState = function(state, period, action) {
      if (typeof root.setInterval === 'undefined') {
        throw new NotSupportedError();
      }
      period = normalizeTime(period);
      var s = state,
          id = root.setInterval(function() {
            s = action(s);
          }, period);
      return disposableCreate(function() {
        root.clearInterval(id);
      });
    };
  }(Scheduler.prototype));
  (function(schedulerProto) {
    schedulerProto.catchError = schedulerProto['catch'] = function(handler) {
      return new CatchScheduler(this, handler);
    };
  }(Scheduler.prototype));
  var SchedulePeriodicRecursive = Rx.internals.SchedulePeriodicRecursive = (function() {
    function tick(command, recurse) {
      recurse(0, this._period);
      try {
        this._state = this._action(this._state);
      } catch (e) {
        this._cancel.dispose();
        throw e;
      }
    }
    function SchedulePeriodicRecursive(scheduler, state, period, action) {
      this._scheduler = scheduler;
      this._state = state;
      this._period = period;
      this._action = action;
    }
    SchedulePeriodicRecursive.prototype.start = function() {
      var d = new SingleAssignmentDisposable();
      this._cancel = d;
      d.setDisposable(this._scheduler.scheduleRecursiveWithRelativeAndState(0, this._period, tick.bind(this)));
      return d;
    };
    return SchedulePeriodicRecursive;
  }());
  var immediateScheduler = Scheduler.immediate = (function() {
    function scheduleNow(state, action) {
      return action(this, state);
    }
    return new Scheduler(defaultNow, scheduleNow, notSupported, notSupported);
  }());
  var currentThreadScheduler = Scheduler.currentThread = (function() {
    var queue;
    function runTrampoline() {
      while (queue.length > 0) {
        var item = queue.dequeue();
        !item.isCancelled() && item.invoke();
      }
    }
    function scheduleNow(state, action) {
      var si = new ScheduledItem(this, state, action, this.now());
      if (!queue) {
        queue = new PriorityQueue(4);
        queue.enqueue(si);
        var result = tryCatch(runTrampoline)();
        queue = null;
        if (result === errorObj) {
          return thrower(result.e);
        }
      } else {
        queue.enqueue(si);
      }
      return si.disposable;
    }
    var currentScheduler = new Scheduler(defaultNow, scheduleNow, notSupported, notSupported);
    currentScheduler.scheduleRequired = function() {
      return !queue;
    };
    return currentScheduler;
  }());
  var scheduleMethod,
      clearMethod = noop;
  var localTimer = (function() {
    var localSetTimeout,
        localClearTimeout = noop;
    if ('WScript' in this) {
      localSetTimeout = function(fn, time) {
        WScript.Sleep(time);
        fn();
      };
    } else if (!!root.setTimeout) {
      localSetTimeout = root.setTimeout;
      localClearTimeout = root.clearTimeout;
    } else {
      throw new NotSupportedError();
    }
    return {
      setTimeout: localSetTimeout,
      clearTimeout: localClearTimeout
    };
  }());
  var localSetTimeout = localTimer.setTimeout,
      localClearTimeout = localTimer.clearTimeout;
  (function() {
    var taskId = 0,
        tasks = new Array(1000);
    var reNative = RegExp('^' + String(toString).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/toString| for [^\]]+/g, '.*?') + '$');
    var setImmediate = typeof(setImmediate = freeGlobal && moduleExports && freeGlobal.setImmediate) == 'function' && !reNative.test(setImmediate) && setImmediate,
        clearImmediate = typeof(clearImmediate = freeGlobal && moduleExports && freeGlobal.clearImmediate) == 'function' && !reNative.test(clearImmediate) && clearImmediate;
    function postMessageSupported() {
      if (!root.postMessage || root.importScripts) {
        return false;
      }
      var isAsync = false,
          oldHandler = root.onmessage;
      root.onmessage = function() {
        isAsync = true;
      };
      root.postMessage('', '*');
      root.onmessage = oldHandler;
      return isAsync;
    }
    if (typeof setImmediate === 'function') {
      scheduleMethod = setImmediate;
      clearMethod = clearImmediate;
    } else if (typeof process !== 'undefined' && {}.toString.call(process) === '[object process]') {
      scheduleMethod = process.nextTick;
    } else if (postMessageSupported()) {
      var MSG_PREFIX = 'ms.rx.schedule' + Math.random();
      var onGlobalPostMessage = function(event) {
        if (typeof event.data === 'string' && event.data.substring(0, MSG_PREFIX.length) === MSG_PREFIX) {
          var handleId = event.data.substring(MSG_PREFIX.length),
              action = tasks[handleId];
          action();
          tasks[handleId] = undefined;
        }
      };
      if (root.addEventListener) {
        root.addEventListener('message', onGlobalPostMessage, false);
      } else {
        root.attachEvent('onmessage', onGlobalPostMessage, false);
      }
      scheduleMethod = function(action) {
        var currentId = taskId++;
        tasks[currentId] = action;
        root.postMessage(MSG_PREFIX + currentId, '*');
      };
    } else if (!!root.MessageChannel) {
      var channel = new root.MessageChannel();
      channel.port1.onmessage = function(event) {
        var id = event.data,
            action = tasks[id];
        action();
        tasks[id] = undefined;
      };
      scheduleMethod = function(action) {
        var id = taskId++;
        tasks[id] = action;
        channel.port2.postMessage(id);
      };
    } else if ('document' in root && 'onreadystatechange' in root.document.createElement('script')) {
      scheduleMethod = function(action) {
        var scriptElement = root.document.createElement('script');
        scriptElement.onreadystatechange = function() {
          action();
          scriptElement.onreadystatechange = null;
          scriptElement.parentNode.removeChild(scriptElement);
          scriptElement = null;
        };
        root.document.documentElement.appendChild(scriptElement);
      };
    } else {
      scheduleMethod = function(action) {
        return localSetTimeout(action, 0);
      };
      clearMethod = localClearTimeout;
    }
  }());
  var timeoutScheduler = Scheduler.timeout = Scheduler.default = (function() {
    function scheduleNow(state, action) {
      var scheduler = this,
          disposable = new SingleAssignmentDisposable();
      var id = scheduleMethod(function() {
        if (!disposable.isDisposed) {
          disposable.setDisposable(action(scheduler, state));
        }
      });
      return new CompositeDisposable(disposable, disposableCreate(function() {
        clearMethod(id);
      }));
    }
    function scheduleRelative(state, dueTime, action) {
      var scheduler = this,
          dt = Scheduler.normalize(dueTime);
      if (dt === 0) {
        return scheduler.scheduleWithState(state, action);
      }
      var disposable = new SingleAssignmentDisposable();
      var id = localSetTimeout(function() {
        if (!disposable.isDisposed) {
          disposable.setDisposable(action(scheduler, state));
        }
      }, dt);
      return new CompositeDisposable(disposable, disposableCreate(function() {
        localClearTimeout(id);
      }));
    }
    function scheduleAbsolute(state, dueTime, action) {
      return this.scheduleWithRelativeAndState(state, dueTime - this.now(), action);
    }
    return new Scheduler(defaultNow, scheduleNow, scheduleRelative, scheduleAbsolute);
  })();
  var CatchScheduler = (function(__super__) {
    function scheduleNow(state, action) {
      return this._scheduler.scheduleWithState(state, this._wrap(action));
    }
    function scheduleRelative(state, dueTime, action) {
      return this._scheduler.scheduleWithRelativeAndState(state, dueTime, this._wrap(action));
    }
    function scheduleAbsolute(state, dueTime, action) {
      return this._scheduler.scheduleWithAbsoluteAndState(state, dueTime, this._wrap(action));
    }
    inherits(CatchScheduler, __super__);
    function CatchScheduler(scheduler, handler) {
      this._scheduler = scheduler;
      this._handler = handler;
      this._recursiveOriginal = null;
      this._recursiveWrapper = null;
      __super__.call(this, this._scheduler.now.bind(this._scheduler), scheduleNow, scheduleRelative, scheduleAbsolute);
    }
    CatchScheduler.prototype._clone = function(scheduler) {
      return new CatchScheduler(scheduler, this._handler);
    };
    CatchScheduler.prototype._wrap = function(action) {
      var parent = this;
      return function(self, state) {
        try {
          return action(parent._getRecursiveWrapper(self), state);
        } catch (e) {
          if (!parent._handler(e)) {
            throw e;
          }
          return disposableEmpty;
        }
      };
    };
    CatchScheduler.prototype._getRecursiveWrapper = function(scheduler) {
      if (this._recursiveOriginal !== scheduler) {
        this._recursiveOriginal = scheduler;
        var wrapper = this._clone(scheduler);
        wrapper._recursiveOriginal = scheduler;
        wrapper._recursiveWrapper = wrapper;
        this._recursiveWrapper = wrapper;
      }
      return this._recursiveWrapper;
    };
    CatchScheduler.prototype.schedulePeriodicWithState = function(state, period, action) {
      var self = this,
          failed = false,
          d = new SingleAssignmentDisposable();
      d.setDisposable(this._scheduler.schedulePeriodicWithState(state, period, function(state1) {
        if (failed) {
          return null;
        }
        try {
          return action(state1);
        } catch (e) {
          failed = true;
          if (!self._handler(e)) {
            throw e;
          }
          d.dispose();
          return null;
        }
      }));
      return d;
    };
    return CatchScheduler;
  }(Scheduler));
  var Notification = Rx.Notification = (function() {
    function Notification(kind, value, exception, accept, acceptObservable, toString) {
      this.kind = kind;
      this.value = value;
      this.exception = exception;
      this._accept = accept;
      this._acceptObservable = acceptObservable;
      this.toString = toString;
    }
    Notification.prototype.accept = function(observerOrOnNext, onError, onCompleted) {
      return observerOrOnNext && typeof observerOrOnNext === 'object' ? this._acceptObservable(observerOrOnNext) : this._accept(observerOrOnNext, onError, onCompleted);
    };
    Notification.prototype.toObservable = function(scheduler) {
      var self = this;
      isScheduler(scheduler) || (scheduler = immediateScheduler);
      return new AnonymousObservable(function(observer) {
        return scheduler.scheduleWithState(self, function(_, notification) {
          notification._acceptObservable(observer);
          notification.kind === 'N' && observer.onCompleted();
        });
      });
    };
    return Notification;
  })();
  var notificationCreateOnNext = Notification.createOnNext = (function() {
    function _accept(onNext) {
      return onNext(this.value);
    }
    function _acceptObservable(observer) {
      return observer.onNext(this.value);
    }
    function toString() {
      return 'OnNext(' + this.value + ')';
    }
    return function(value) {
      return new Notification('N', value, null, _accept, _acceptObservable, toString);
    };
  }());
  var notificationCreateOnError = Notification.createOnError = (function() {
    function _accept(onNext, onError) {
      return onError(this.exception);
    }
    function _acceptObservable(observer) {
      return observer.onError(this.exception);
    }
    function toString() {
      return 'OnError(' + this.exception + ')';
    }
    return function(e) {
      return new Notification('E', null, e, _accept, _acceptObservable, toString);
    };
  }());
  var notificationCreateOnCompleted = Notification.createOnCompleted = (function() {
    function _accept(onNext, onError, onCompleted) {
      return onCompleted();
    }
    function _acceptObservable(observer) {
      return observer.onCompleted();
    }
    function toString() {
      return 'OnCompleted()';
    }
    return function() {
      return new Notification('C', null, null, _accept, _acceptObservable, toString);
    };
  }());
  var Enumerator = Rx.internals.Enumerator = function(next) {
    this._next = next;
  };
  Enumerator.prototype.next = function() {
    return this._next();
  };
  Enumerator.prototype[$iterator$] = function() {
    return this;
  };
  var Enumerable = Rx.internals.Enumerable = function(iterator) {
    this._iterator = iterator;
  };
  Enumerable.prototype[$iterator$] = function() {
    return this._iterator();
  };
  Enumerable.prototype.concat = function() {
    var sources = this;
    return new AnonymousObservable(function(o) {
      var e = sources[$iterator$]();
      var isDisposed,
          subscription = new SerialDisposable();
      var cancelable = immediateScheduler.scheduleRecursive(function(self) {
        if (isDisposed) {
          return ;
        }
        try {
          var currentItem = e.next();
        } catch (ex) {
          return o.onError(ex);
        }
        if (currentItem.done) {
          return o.onCompleted();
        }
        var currentValue = currentItem.value;
        isPromise(currentValue) && (currentValue = observableFromPromise(currentValue));
        var d = new SingleAssignmentDisposable();
        subscription.setDisposable(d);
        d.setDisposable(currentValue.subscribe(function(x) {
          o.onNext(x);
        }, function(err) {
          o.onError(err);
        }, self));
      });
      return new CompositeDisposable(subscription, cancelable, disposableCreate(function() {
        isDisposed = true;
      }));
    });
  };
  Enumerable.prototype.catchError = function() {
    var sources = this;
    return new AnonymousObservable(function(o) {
      var e = sources[$iterator$]();
      var isDisposed,
          subscription = new SerialDisposable();
      var cancelable = immediateScheduler.scheduleRecursiveWithState(null, function(lastException, self) {
        if (isDisposed) {
          return ;
        }
        try {
          var currentItem = e.next();
        } catch (ex) {
          return observer.onError(ex);
        }
        if (currentItem.done) {
          if (lastException !== null) {
            o.onError(lastException);
          } else {
            o.onCompleted();
          }
          return ;
        }
        var currentValue = currentItem.value;
        isPromise(currentValue) && (currentValue = observableFromPromise(currentValue));
        var d = new SingleAssignmentDisposable();
        subscription.setDisposable(d);
        d.setDisposable(currentValue.subscribe(function(x) {
          o.onNext(x);
        }, self, function() {
          o.onCompleted();
        }));
      });
      return new CompositeDisposable(subscription, cancelable, disposableCreate(function() {
        isDisposed = true;
      }));
    });
  };
  Enumerable.prototype.catchErrorWhen = function(notificationHandler) {
    var sources = this;
    return new AnonymousObservable(function(o) {
      var exceptions = new Subject(),
          notifier = new Subject(),
          handled = notificationHandler(exceptions),
          notificationDisposable = handled.subscribe(notifier);
      var e = sources[$iterator$]();
      var isDisposed,
          lastException,
          subscription = new SerialDisposable();
      var cancelable = immediateScheduler.scheduleRecursive(function(self) {
        if (isDisposed) {
          return ;
        }
        try {
          var currentItem = e.next();
        } catch (ex) {
          return o.onError(ex);
        }
        if (currentItem.done) {
          if (lastException) {
            o.onError(lastException);
          } else {
            o.onCompleted();
          }
          return ;
        }
        var currentValue = currentItem.value;
        isPromise(currentValue) && (currentValue = observableFromPromise(currentValue));
        var outer = new SingleAssignmentDisposable();
        var inner = new SingleAssignmentDisposable();
        subscription.setDisposable(new CompositeDisposable(inner, outer));
        outer.setDisposable(currentValue.subscribe(function(x) {
          o.onNext(x);
        }, function(exn) {
          inner.setDisposable(notifier.subscribe(self, function(ex) {
            o.onError(ex);
          }, function() {
            o.onCompleted();
          }));
          exceptions.onNext(exn);
        }, function() {
          o.onCompleted();
        }));
      });
      return new CompositeDisposable(notificationDisposable, subscription, cancelable, disposableCreate(function() {
        isDisposed = true;
      }));
    });
  };
  var enumerableRepeat = Enumerable.repeat = function(value, repeatCount) {
    if (repeatCount == null) {
      repeatCount = -1;
    }
    return new Enumerable(function() {
      var left = repeatCount;
      return new Enumerator(function() {
        if (left === 0) {
          return doneEnumerator;
        }
        if (left > 0) {
          left--;
        }
        return {
          done: false,
          value: value
        };
      });
    });
  };
  var enumerableOf = Enumerable.of = function(source, selector, thisArg) {
    if (selector) {
      var selectorFn = bindCallback(selector, thisArg, 3);
    }
    return new Enumerable(function() {
      var index = -1;
      return new Enumerator(function() {
        return ++index < source.length ? {
          done: false,
          value: !selector ? source[index] : selectorFn(source[index], index, source)
        } : doneEnumerator;
      });
    });
  };
  var Observer = Rx.Observer = function() {};
  Observer.prototype.toNotifier = function() {
    var observer = this;
    return function(n) {
      return n.accept(observer);
    };
  };
  Observer.prototype.asObserver = function() {
    return new AnonymousObserver(this.onNext.bind(this), this.onError.bind(this), this.onCompleted.bind(this));
  };
  Observer.prototype.checked = function() {
    return new CheckedObserver(this);
  };
  var observerCreate = Observer.create = function(onNext, onError, onCompleted) {
    onNext || (onNext = noop);
    onError || (onError = defaultError);
    onCompleted || (onCompleted = noop);
    return new AnonymousObserver(onNext, onError, onCompleted);
  };
  Observer.fromNotifier = function(handler, thisArg) {
    return new AnonymousObserver(function(x) {
      return handler.call(thisArg, notificationCreateOnNext(x));
    }, function(e) {
      return handler.call(thisArg, notificationCreateOnError(e));
    }, function() {
      return handler.call(thisArg, notificationCreateOnCompleted());
    });
  };
  Observer.prototype.notifyOn = function(scheduler) {
    return new ObserveOnObserver(scheduler, this);
  };
  Observer.prototype.makeSafe = function(disposable) {
    return new AnonymousSafeObserver(this._onNext, this._onError, this._onCompleted, disposable);
  };
  var AbstractObserver = Rx.internals.AbstractObserver = (function(__super__) {
    inherits(AbstractObserver, __super__);
    function AbstractObserver() {
      this.isStopped = false;
      __super__.call(this);
    }
    AbstractObserver.prototype.next = notImplemented;
    AbstractObserver.prototype.error = notImplemented;
    AbstractObserver.prototype.completed = notImplemented;
    AbstractObserver.prototype.onNext = function(value) {
      if (!this.isStopped) {
        this.next(value);
      }
    };
    AbstractObserver.prototype.onError = function(error) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.error(error);
      }
    };
    AbstractObserver.prototype.onCompleted = function() {
      if (!this.isStopped) {
        this.isStopped = true;
        this.completed();
      }
    };
    AbstractObserver.prototype.dispose = function() {
      this.isStopped = true;
    };
    AbstractObserver.prototype.fail = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.error(e);
        return true;
      }
      return false;
    };
    return AbstractObserver;
  }(Observer));
  var AnonymousObserver = Rx.AnonymousObserver = (function(__super__) {
    inherits(AnonymousObserver, __super__);
    function AnonymousObserver(onNext, onError, onCompleted) {
      __super__.call(this);
      this._onNext = onNext;
      this._onError = onError;
      this._onCompleted = onCompleted;
    }
    AnonymousObserver.prototype.next = function(value) {
      this._onNext(value);
    };
    AnonymousObserver.prototype.error = function(error) {
      this._onError(error);
    };
    AnonymousObserver.prototype.completed = function() {
      this._onCompleted();
    };
    return AnonymousObserver;
  }(AbstractObserver));
  var CheckedObserver = (function(__super__) {
    inherits(CheckedObserver, __super__);
    function CheckedObserver(observer) {
      __super__.call(this);
      this._observer = observer;
      this._state = 0;
    }
    var CheckedObserverPrototype = CheckedObserver.prototype;
    CheckedObserverPrototype.onNext = function(value) {
      this.checkAccess();
      var res = tryCatch(this._observer.onNext).call(this._observer, value);
      this._state = 0;
      res === errorObj && thrower(res.e);
    };
    CheckedObserverPrototype.onError = function(err) {
      this.checkAccess();
      var res = tryCatch(this._observer.onError).call(this._observer, err);
      this._state = 2;
      res === errorObj && thrower(res.e);
    };
    CheckedObserverPrototype.onCompleted = function() {
      this.checkAccess();
      var res = tryCatch(this._observer.onCompleted).call(this._observer);
      this._state = 2;
      res === errorObj && thrower(res.e);
    };
    CheckedObserverPrototype.checkAccess = function() {
      if (this._state === 1) {
        throw new Error('Re-entrancy detected');
      }
      if (this._state === 2) {
        throw new Error('Observer completed');
      }
      if (this._state === 0) {
        this._state = 1;
      }
    };
    return CheckedObserver;
  }(Observer));
  var ScheduledObserver = Rx.internals.ScheduledObserver = (function(__super__) {
    inherits(ScheduledObserver, __super__);
    function ScheduledObserver(scheduler, observer) {
      __super__.call(this);
      this.scheduler = scheduler;
      this.observer = observer;
      this.isAcquired = false;
      this.hasFaulted = false;
      this.queue = [];
      this.disposable = new SerialDisposable();
    }
    ScheduledObserver.prototype.next = function(value) {
      var self = this;
      this.queue.push(function() {
        self.observer.onNext(value);
      });
    };
    ScheduledObserver.prototype.error = function(e) {
      var self = this;
      this.queue.push(function() {
        self.observer.onError(e);
      });
    };
    ScheduledObserver.prototype.completed = function() {
      var self = this;
      this.queue.push(function() {
        self.observer.onCompleted();
      });
    };
    ScheduledObserver.prototype.ensureActive = function() {
      var isOwner = false,
          parent = this;
      if (!this.hasFaulted && this.queue.length > 0) {
        isOwner = !this.isAcquired;
        this.isAcquired = true;
      }
      if (isOwner) {
        this.disposable.setDisposable(this.scheduler.scheduleRecursive(function(self) {
          var work;
          if (parent.queue.length > 0) {
            work = parent.queue.shift();
          } else {
            parent.isAcquired = false;
            return ;
          }
          try {
            work();
          } catch (ex) {
            parent.queue = [];
            parent.hasFaulted = true;
            throw ex;
          }
          self();
        }));
      }
    };
    ScheduledObserver.prototype.dispose = function() {
      __super__.prototype.dispose.call(this);
      this.disposable.dispose();
    };
    return ScheduledObserver;
  }(AbstractObserver));
  var ObserveOnObserver = (function(__super__) {
    inherits(ObserveOnObserver, __super__);
    function ObserveOnObserver(scheduler, observer, cancel) {
      __super__.call(this, scheduler, observer);
      this._cancel = cancel;
    }
    ObserveOnObserver.prototype.next = function(value) {
      __super__.prototype.next.call(this, value);
      this.ensureActive();
    };
    ObserveOnObserver.prototype.error = function(e) {
      __super__.prototype.error.call(this, e);
      this.ensureActive();
    };
    ObserveOnObserver.prototype.completed = function() {
      __super__.prototype.completed.call(this);
      this.ensureActive();
    };
    ObserveOnObserver.prototype.dispose = function() {
      __super__.prototype.dispose.call(this);
      this._cancel && this._cancel.dispose();
      this._cancel = null;
    };
    return ObserveOnObserver;
  })(ScheduledObserver);
  var observableProto;
  var Observable = Rx.Observable = (function() {
    function Observable(subscribe) {
      if (Rx.config.longStackSupport && hasStacks) {
        try {
          throw new Error();
        } catch (e) {
          this.stack = e.stack.substring(e.stack.indexOf("\n") + 1);
        }
        var self = this;
        this._subscribe = function(observer) {
          var oldOnError = observer.onError.bind(observer);
          observer.onError = function(err) {
            makeStackTraceLong(err, self);
            oldOnError(err);
          };
          return subscribe.call(self, observer);
        };
      } else {
        this._subscribe = subscribe;
      }
    }
    observableProto = Observable.prototype;
    observableProto.subscribe = observableProto.forEach = function(observerOrOnNext, onError, onCompleted) {
      return this._subscribe(typeof observerOrOnNext === 'object' ? observerOrOnNext : observerCreate(observerOrOnNext, onError, onCompleted));
    };
    observableProto.subscribeOnNext = function(onNext, thisArg) {
      return this._subscribe(observerCreate(typeof thisArg !== 'undefined' ? function(x) {
        onNext.call(thisArg, x);
      } : onNext));
    };
    observableProto.subscribeOnError = function(onError, thisArg) {
      return this._subscribe(observerCreate(null, typeof thisArg !== 'undefined' ? function(e) {
        onError.call(thisArg, e);
      } : onError));
    };
    observableProto.subscribeOnCompleted = function(onCompleted, thisArg) {
      return this._subscribe(observerCreate(null, null, typeof thisArg !== 'undefined' ? function() {
        onCompleted.call(thisArg);
      } : onCompleted));
    };
    return Observable;
  })();
  var ObservableBase = Rx.ObservableBase = (function(__super__) {
    inherits(ObservableBase, __super__);
    function fixSubscriber(subscriber) {
      return subscriber && isFunction(subscriber.dispose) ? subscriber : isFunction(subscriber) ? disposableCreate(subscriber) : disposableEmpty;
    }
    function setDisposable(s, state) {
      var ado = state[0],
          self = state[1];
      var sub = tryCatch(self.subscribeCore).call(self, ado);
      if (sub === errorObj) {
        if (!ado.fail(errorObj.e)) {
          return thrower(errorObj.e);
        }
      }
      ado.setDisposable(fixSubscriber(sub));
    }
    function subscribe(observer) {
      var ado = new AutoDetachObserver(observer),
          state = [ado, this];
      if (currentThreadScheduler.scheduleRequired()) {
        currentThreadScheduler.scheduleWithState(state, setDisposable);
      } else {
        setDisposable(null, state);
      }
      return ado;
    }
    function ObservableBase() {
      __super__.call(this, subscribe);
    }
    ObservableBase.prototype.subscribeCore = notImplemented;
    return ObservableBase;
  }(Observable));
  observableProto.observeOn = function(scheduler) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      return source.subscribe(new ObserveOnObserver(scheduler, observer));
    }, source);
  };
  observableProto.subscribeOn = function(scheduler) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var m = new SingleAssignmentDisposable(),
          d = new SerialDisposable();
      d.setDisposable(m);
      m.setDisposable(scheduler.schedule(function() {
        d.setDisposable(new ScheduledDisposable(scheduler, source.subscribe(observer)));
      }));
      return d;
    }, source);
  };
  var observableFromPromise = Observable.fromPromise = function(promise) {
    return observableDefer(function() {
      var subject = new Rx.AsyncSubject();
      promise.then(function(value) {
        subject.onNext(value);
        subject.onCompleted();
      }, subject.onError.bind(subject));
      return subject;
    });
  };
  observableProto.toPromise = function(promiseCtor) {
    promiseCtor || (promiseCtor = Rx.config.Promise);
    if (!promiseCtor) {
      throw new NotSupportedError('Promise type not provided nor in Rx.config.Promise');
    }
    var source = this;
    return new promiseCtor(function(resolve, reject) {
      var value,
          hasValue = false;
      source.subscribe(function(v) {
        value = v;
        hasValue = true;
      }, reject, function() {
        hasValue && resolve(value);
      });
    });
  };
  var ToArrayObservable = (function(__super__) {
    inherits(ToArrayObservable, __super__);
    function ToArrayObservable(source) {
      this.source = source;
      __super__.call(this);
    }
    ToArrayObservable.prototype.subscribeCore = function(observer) {
      return this.source.subscribe(new ToArrayObserver(observer));
    };
    return ToArrayObservable;
  }(ObservableBase));
  function ToArrayObserver(observer) {
    this.observer = observer;
    this.a = [];
    this.isStopped = false;
  }
  ToArrayObserver.prototype.onNext = function(x) {
    if (!this.isStopped) {
      this.a.push(x);
    }
  };
  ToArrayObserver.prototype.onError = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
    }
  };
  ToArrayObserver.prototype.onCompleted = function() {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onNext(this.a);
      this.observer.onCompleted();
    }
  };
  ToArrayObserver.prototype.dispose = function() {
    this.isStopped = true;
  };
  ToArrayObserver.prototype.fail = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
      return true;
    }
    return false;
  };
  observableProto.toArray = function() {
    return new ToArrayObservable(this);
  };
  Observable.create = Observable.createWithDisposable = function(subscribe, parent) {
    return new AnonymousObservable(subscribe, parent);
  };
  var observableDefer = Observable.defer = function(observableFactory) {
    return new AnonymousObservable(function(observer) {
      var result;
      try {
        result = observableFactory();
      } catch (e) {
        return observableThrow(e).subscribe(observer);
      }
      isPromise(result) && (result = observableFromPromise(result));
      return result.subscribe(observer);
    });
  };
  var observableEmpty = Observable.empty = function(scheduler) {
    isScheduler(scheduler) || (scheduler = immediateScheduler);
    return new AnonymousObservable(function(observer) {
      return scheduler.schedule(function() {
        observer.onCompleted();
      });
    });
  };
  var FromObservable = (function(__super__) {
    inherits(FromObservable, __super__);
    function FromObservable(iterable, mapper, scheduler) {
      this.iterable = iterable;
      this.mapper = mapper;
      this.scheduler = scheduler;
      __super__.call(this);
    }
    FromObservable.prototype.subscribeCore = function(observer) {
      var sink = new FromSink(observer, this);
      return sink.run();
    };
    return FromObservable;
  }(ObservableBase));
  var FromSink = (function() {
    function FromSink(observer, parent) {
      this.observer = observer;
      this.parent = parent;
    }
    FromSink.prototype.run = function() {
      var list = Object(this.parent.iterable),
          it = getIterable(list),
          observer = this.observer,
          mapper = this.parent.mapper;
      function loopRecursive(i, recurse) {
        try {
          var next = it.next();
        } catch (e) {
          return observer.onError(e);
        }
        if (next.done) {
          return observer.onCompleted();
        }
        var result = next.value;
        if (mapper) {
          try {
            result = mapper(result, i);
          } catch (e) {
            return observer.onError(e);
          }
        }
        observer.onNext(result);
        recurse(i + 1);
      }
      return this.parent.scheduler.scheduleRecursiveWithState(0, loopRecursive);
    };
    return FromSink;
  }());
  var maxSafeInteger = Math.pow(2, 53) - 1;
  function StringIterable(str) {
    this._s = s;
  }
  StringIterable.prototype[$iterator$] = function() {
    return new StringIterator(this._s);
  };
  function StringIterator(str) {
    this._s = s;
    this._l = s.length;
    this._i = 0;
  }
  StringIterator.prototype[$iterator$] = function() {
    return this;
  };
  StringIterator.prototype.next = function() {
    return this._i < this._l ? {
      done: false,
      value: this._s.charAt(this._i++)
    } : doneEnumerator;
  };
  function ArrayIterable(a) {
    this._a = a;
  }
  ArrayIterable.prototype[$iterator$] = function() {
    return new ArrayIterator(this._a);
  };
  function ArrayIterator(a) {
    this._a = a;
    this._l = toLength(a);
    this._i = 0;
  }
  ArrayIterator.prototype[$iterator$] = function() {
    return this;
  };
  ArrayIterator.prototype.next = function() {
    return this._i < this._l ? {
      done: false,
      value: this._a[this._i++]
    } : doneEnumerator;
  };
  function numberIsFinite(value) {
    return typeof value === 'number' && root.isFinite(value);
  }
  function isNan(n) {
    return n !== n;
  }
  function getIterable(o) {
    var i = o[$iterator$],
        it;
    if (!i && typeof o === 'string') {
      it = new StringIterable(o);
      return it[$iterator$]();
    }
    if (!i && o.length !== undefined) {
      it = new ArrayIterable(o);
      return it[$iterator$]();
    }
    if (!i) {
      throw new TypeError('Object is not iterable');
    }
    return o[$iterator$]();
  }
  function sign(value) {
    var number = +value;
    if (number === 0) {
      return number;
    }
    if (isNaN(number)) {
      return number;
    }
    return number < 0 ? -1 : 1;
  }
  function toLength(o) {
    var len = +o.length;
    if (isNaN(len)) {
      return 0;
    }
    if (len === 0 || !numberIsFinite(len)) {
      return len;
    }
    len = sign(len) * Math.floor(Math.abs(len));
    if (len <= 0) {
      return 0;
    }
    if (len > maxSafeInteger) {
      return maxSafeInteger;
    }
    return len;
  }
  var observableFrom = Observable.from = function(iterable, mapFn, thisArg, scheduler) {
    if (iterable == null) {
      throw new Error('iterable cannot be null.');
    }
    if (mapFn && !isFunction(mapFn)) {
      throw new Error('mapFn when provided must be a function');
    }
    if (mapFn) {
      var mapper = bindCallback(mapFn, thisArg, 2);
    }
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return new FromObservable(iterable, mapper, scheduler);
  };
  var FromArrayObservable = (function(__super__) {
    inherits(FromArrayObservable, __super__);
    function FromArrayObservable(args, scheduler) {
      this.args = args;
      this.scheduler = scheduler;
      __super__.call(this);
    }
    FromArrayObservable.prototype.subscribeCore = function(observer) {
      var sink = new FromArraySink(observer, this);
      return sink.run();
    };
    return FromArrayObservable;
  }(ObservableBase));
  function FromArraySink(observer, parent) {
    this.observer = observer;
    this.parent = parent;
  }
  FromArraySink.prototype.run = function() {
    var observer = this.observer,
        args = this.parent.args,
        len = args.length;
    function loopRecursive(i, recurse) {
      if (i < len) {
        observer.onNext(args[i]);
        recurse(i + 1);
      } else {
        observer.onCompleted();
      }
    }
    return this.parent.scheduler.scheduleRecursiveWithState(0, loopRecursive);
  };
  var observableFromArray = Observable.fromArray = function(array, scheduler) {
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return new FromArrayObservable(array, scheduler);
  };
  Observable.generate = function(initialState, condition, iterate, resultSelector, scheduler) {
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return new AnonymousObservable(function(observer) {
      var first = true,
          state = initialState;
      return scheduler.scheduleRecursive(function(self) {
        var hasResult,
            result;
        try {
          if (first) {
            first = false;
          } else {
            state = iterate(state);
          }
          hasResult = condition(state);
          if (hasResult) {
            result = resultSelector(state);
          }
        } catch (exception) {
          observer.onError(exception);
          return ;
        }
        if (hasResult) {
          observer.onNext(result);
          self();
        } else {
          observer.onCompleted();
        }
      });
    });
  };
  function observableOf(scheduler, array) {
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return new FromArrayObservable(array, scheduler);
  }
  Observable.of = function() {
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    return new FromArrayObservable(args, currentThreadScheduler);
  };
  Observable.ofWithScheduler = function(scheduler) {
    var len = arguments.length,
        args = new Array(len - 1);
    for (var i = 1; i < len; i++) {
      args[i - 1] = arguments[i];
    }
    return new FromArrayObservable(args, scheduler);
  };
  Observable.ofArrayChanges = function(array) {
    if (!Array.isArray(array)) {
      throw new TypeError('Array.observe only accepts arrays.');
    }
    if (typeof Array.observe !== 'function' && typeof Array.unobserve !== 'function') {
      throw new TypeError('Array.observe is not supported on your platform');
    }
    return new AnonymousObservable(function(observer) {
      function observerFn(changes) {
        for (var i = 0,
            len = changes.length; i < len; i++) {
          observer.onNext(changes[i]);
        }
      }
      Array.observe(array, observerFn);
      return function() {
        Array.unobserve(array, observerFn);
      };
    });
  };
  Observable.ofObjectChanges = function(obj) {
    if (obj == null) {
      throw new TypeError('object must not be null or undefined.');
    }
    if (typeof Object.observe !== 'function' && typeof Object.unobserve !== 'function') {
      throw new TypeError('Array.observe is not supported on your platform');
    }
    return new AnonymousObservable(function(observer) {
      function observerFn(changes) {
        for (var i = 0,
            len = changes.length; i < len; i++) {
          observer.onNext(changes[i]);
        }
      }
      Object.observe(obj, observerFn);
      return function() {
        Object.unobserve(obj, observerFn);
      };
    });
  };
  var observableNever = Observable.never = function() {
    return new AnonymousObservable(function() {
      return disposableEmpty;
    });
  };
  Observable.pairs = function(obj, scheduler) {
    scheduler || (scheduler = Rx.Scheduler.currentThread);
    return new AnonymousObservable(function(observer) {
      var keys = Object.keys(obj),
          len = keys.length;
      return scheduler.scheduleRecursiveWithState(0, function(idx, self) {
        if (idx < len) {
          var key = keys[idx];
          observer.onNext([key, obj[key]]);
          self(idx + 1);
        } else {
          observer.onCompleted();
        }
      });
    });
  };
  var RangeObservable = (function(__super__) {
    inherits(RangeObservable, __super__);
    function RangeObservable(start, count, scheduler) {
      this.start = start;
      this.count = count;
      this.scheduler = scheduler;
      __super__.call(this);
    }
    RangeObservable.prototype.subscribeCore = function(observer) {
      var sink = new RangeSink(observer, this);
      return sink.run();
    };
    return RangeObservable;
  }(ObservableBase));
  var RangeSink = (function() {
    function RangeSink(observer, parent) {
      this.observer = observer;
      this.parent = parent;
    }
    RangeSink.prototype.run = function() {
      var start = this.parent.start,
          count = this.parent.count,
          observer = this.observer;
      function loopRecursive(i, recurse) {
        if (i < count) {
          observer.onNext(start + i);
          recurse(i + 1);
        } else {
          observer.onCompleted();
        }
      }
      return this.parent.scheduler.scheduleRecursiveWithState(0, loopRecursive);
    };
    return RangeSink;
  }());
  Observable.range = function(start, count, scheduler) {
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return new RangeObservable(start, count, scheduler);
  };
  Observable.repeat = function(value, repeatCount, scheduler) {
    isScheduler(scheduler) || (scheduler = currentThreadScheduler);
    return observableReturn(value, scheduler).repeat(repeatCount == null ? -1 : repeatCount);
  };
  var observableReturn = Observable['return'] = Observable.just = function(value, scheduler) {
    isScheduler(scheduler) || (scheduler = immediateScheduler);
    return new AnonymousObservable(function(observer) {
      return scheduler.schedule(function() {
        observer.onNext(value);
        observer.onCompleted();
      });
    });
  };
  Observable.returnValue = function() {
    return observableReturn.apply(null, arguments);
  };
  var observableThrow = Observable['throw'] = Observable.throwError = function(error, scheduler) {
    isScheduler(scheduler) || (scheduler = immediateScheduler);
    return new AnonymousObservable(function(observer) {
      return scheduler.schedule(function() {
        observer.onError(error);
      });
    });
  };
  Observable.throwException = function() {
    return Observable.throwError.apply(null, arguments);
  };
  Observable.using = function(resourceFactory, observableFactory) {
    return new AnonymousObservable(function(observer) {
      var disposable = disposableEmpty,
          resource,
          source;
      try {
        resource = resourceFactory();
        resource && (disposable = resource);
        source = observableFactory(resource);
      } catch (exception) {
        return new CompositeDisposable(observableThrow(exception).subscribe(observer), disposable);
      }
      return new CompositeDisposable(source.subscribe(observer), disposable);
    });
  };
  observableProto.amb = function(rightSource) {
    var leftSource = this;
    return new AnonymousObservable(function(observer) {
      var choice,
          leftChoice = 'L',
          rightChoice = 'R',
          leftSubscription = new SingleAssignmentDisposable(),
          rightSubscription = new SingleAssignmentDisposable();
      isPromise(rightSource) && (rightSource = observableFromPromise(rightSource));
      function choiceL() {
        if (!choice) {
          choice = leftChoice;
          rightSubscription.dispose();
        }
      }
      function choiceR() {
        if (!choice) {
          choice = rightChoice;
          leftSubscription.dispose();
        }
      }
      leftSubscription.setDisposable(leftSource.subscribe(function(left) {
        choiceL();
        if (choice === leftChoice) {
          observer.onNext(left);
        }
      }, function(err) {
        choiceL();
        if (choice === leftChoice) {
          observer.onError(err);
        }
      }, function() {
        choiceL();
        if (choice === leftChoice) {
          observer.onCompleted();
        }
      }));
      rightSubscription.setDisposable(rightSource.subscribe(function(right) {
        choiceR();
        if (choice === rightChoice) {
          observer.onNext(right);
        }
      }, function(err) {
        choiceR();
        if (choice === rightChoice) {
          observer.onError(err);
        }
      }, function() {
        choiceR();
        if (choice === rightChoice) {
          observer.onCompleted();
        }
      }));
      return new CompositeDisposable(leftSubscription, rightSubscription);
    });
  };
  Observable.amb = function() {
    var acc = observableNever(),
        items = [];
    if (Array.isArray(arguments[0])) {
      items = arguments[0];
    } else {
      for (var i = 0,
          len = arguments.length; i < len; i++) {
        items.push(arguments[i]);
      }
    }
    function func(previous, current) {
      return previous.amb(current);
    }
    for (var i = 0,
        len = items.length; i < len; i++) {
      acc = func(acc, items[i]);
    }
    return acc;
  };
  function observableCatchHandler(source, handler) {
    return new AnonymousObservable(function(o) {
      var d1 = new SingleAssignmentDisposable(),
          subscription = new SerialDisposable();
      subscription.setDisposable(d1);
      d1.setDisposable(source.subscribe(function(x) {
        o.onNext(x);
      }, function(e) {
        try {
          var result = handler(e);
        } catch (ex) {
          return o.onError(ex);
        }
        isPromise(result) && (result = observableFromPromise(result));
        var d = new SingleAssignmentDisposable();
        subscription.setDisposable(d);
        d.setDisposable(result.subscribe(o));
      }, function(x) {
        o.onCompleted(x);
      }));
      return subscription;
    }, source);
  }
  observableProto['catch'] = observableProto.catchError = observableProto.catchException = function(handlerOrSecond) {
    return typeof handlerOrSecond === 'function' ? observableCatchHandler(this, handlerOrSecond) : observableCatch([this, handlerOrSecond]);
  };
  var observableCatch = Observable.catchError = Observable['catch'] = Observable.catchException = function() {
    var items = [];
    if (Array.isArray(arguments[0])) {
      items = arguments[0];
    } else {
      for (var i = 0,
          len = arguments.length; i < len; i++) {
        items.push(arguments[i]);
      }
    }
    return enumerableOf(items).catchError();
  };
  observableProto.combineLatest = function() {
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    if (Array.isArray(args[0])) {
      args[0].unshift(this);
    } else {
      args.unshift(this);
    }
    return combineLatest.apply(this, args);
  };
  var combineLatest = Observable.combineLatest = function() {
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    var resultSelector = args.pop();
    Array.isArray(args[0]) && (args = args[0]);
    return new AnonymousObservable(function(o) {
      var n = args.length,
          falseFactory = function() {
            return false;
          },
          hasValue = arrayInitialize(n, falseFactory),
          hasValueAll = false,
          isDone = arrayInitialize(n, falseFactory),
          values = new Array(n);
      function next(i) {
        hasValue[i] = true;
        if (hasValueAll || (hasValueAll = hasValue.every(identity))) {
          try {
            var res = resultSelector.apply(null, values);
          } catch (e) {
            return o.onError(e);
          }
          o.onNext(res);
        } else if (isDone.filter(function(x, j) {
          return j !== i;
        }).every(identity)) {
          o.onCompleted();
        }
      }
      function done(i) {
        isDone[i] = true;
        isDone.every(identity) && o.onCompleted();
      }
      var subscriptions = new Array(n);
      for (var idx = 0; idx < n; idx++) {
        (function(i) {
          var source = args[i],
              sad = new SingleAssignmentDisposable();
          isPromise(source) && (source = observableFromPromise(source));
          sad.setDisposable(source.subscribe(function(x) {
            values[i] = x;
            next(i);
          }, function(e) {
            o.onError(e);
          }, function() {
            done(i);
          }));
          subscriptions[i] = sad;
        }(idx));
      }
      return new CompositeDisposable(subscriptions);
    }, this);
  };
  observableProto.concat = function() {
    for (var args = [],
        i = 0,
        len = arguments.length; i < len; i++) {
      args.push(arguments[i]);
    }
    args.unshift(this);
    return observableConcat.apply(null, args);
  };
  var observableConcat = Observable.concat = function() {
    var args;
    if (Array.isArray(arguments[0])) {
      args = arguments[0];
    } else {
      args = new Array(arguments.length);
      for (var i = 0,
          len = arguments.length; i < len; i++) {
        args[i] = arguments[i];
      }
    }
    return enumerableOf(args).concat();
  };
  observableProto.concatAll = observableProto.concatObservable = function() {
    return this.merge(1);
  };
  var MergeObservable = (function(__super__) {
    inherits(MergeObservable, __super__);
    function MergeObservable(source, maxConcurrent) {
      this.source = source;
      this.maxConcurrent = maxConcurrent;
      __super__.call(this);
    }
    MergeObservable.prototype.subscribeCore = function(observer) {
      var g = new CompositeDisposable();
      g.add(this.source.subscribe(new MergeObserver(observer, this.maxConcurrent, g)));
      return g;
    };
    return MergeObservable;
  }(ObservableBase));
  var MergeObserver = (function() {
    function MergeObserver(o, max, g) {
      this.o = o;
      this.max = max;
      this.g = g;
      this.done = false;
      this.q = [];
      this.activeCount = 0;
      this.isStopped = false;
    }
    MergeObserver.prototype.handleSubscribe = function(xs) {
      var sad = new SingleAssignmentDisposable();
      this.g.add(sad);
      isPromise(xs) && (xs = observableFromPromise(xs));
      sad.setDisposable(xs.subscribe(new InnerObserver(this, sad)));
    };
    MergeObserver.prototype.onNext = function(innerSource) {
      if (this.isStopped) {
        return ;
      }
      if (this.activeCount < this.max) {
        this.activeCount++;
        this.handleSubscribe(innerSource);
      } else {
        this.q.push(innerSource);
      }
    };
    MergeObserver.prototype.onError = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.o.onError(e);
      }
    };
    MergeObserver.prototype.onCompleted = function() {
      if (!this.isStopped) {
        this.isStopped = true;
        this.done = true;
        this.activeCount === 0 && this.o.onCompleted();
      }
    };
    MergeObserver.prototype.dispose = function() {
      this.isStopped = true;
    };
    MergeObserver.prototype.fail = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.o.onError(e);
        return true;
      }
      return false;
    };
    function InnerObserver(parent, sad) {
      this.parent = parent;
      this.sad = sad;
      this.isStopped = false;
    }
    InnerObserver.prototype.onNext = function(x) {
      if (!this.isStopped) {
        this.parent.o.onNext(x);
      }
    };
    InnerObserver.prototype.onError = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.parent.o.onError(e);
      }
    };
    InnerObserver.prototype.onCompleted = function() {
      if (!this.isStopped) {
        this.isStopped = true;
        var parent = this.parent;
        parent.g.remove(this.sad);
        if (parent.q.length > 0) {
          parent.handleSubscribe(parent.q.shift());
        } else {
          parent.activeCount--;
          parent.done && parent.activeCount === 0 && parent.o.onCompleted();
        }
      }
    };
    InnerObserver.prototype.dispose = function() {
      this.isStopped = true;
    };
    InnerObserver.prototype.fail = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.parent.o.onError(e);
        return true;
      }
      return false;
    };
    return MergeObserver;
  }());
  observableProto.merge = function(maxConcurrentOrOther) {
    return typeof maxConcurrentOrOther !== 'number' ? observableMerge(this, maxConcurrentOrOther) : new MergeObservable(this, maxConcurrentOrOther);
  };
  var observableMerge = Observable.merge = function() {
    var scheduler,
        sources = [],
        i,
        len = arguments.length;
    if (!arguments[0]) {
      scheduler = immediateScheduler;
      for (i = 1; i < len; i++) {
        sources.push(arguments[i]);
      }
    } else if (isScheduler(arguments[0])) {
      scheduler = arguments[0];
      for (i = 1; i < len; i++) {
        sources.push(arguments[i]);
      }
    } else {
      scheduler = immediateScheduler;
      for (i = 0; i < len; i++) {
        sources.push(arguments[i]);
      }
    }
    if (Array.isArray(sources[0])) {
      sources = sources[0];
    }
    return observableOf(scheduler, sources).mergeAll();
  };
  var MergeAllObservable = (function(__super__) {
    inherits(MergeAllObservable, __super__);
    function MergeAllObservable(source) {
      this.source = source;
      __super__.call(this);
    }
    MergeAllObservable.prototype.subscribeCore = function(observer) {
      var g = new CompositeDisposable(),
          m = new SingleAssignmentDisposable();
      g.add(m);
      m.setDisposable(this.source.subscribe(new MergeAllObserver(observer, g)));
      return g;
    };
    return MergeAllObservable;
  }(ObservableBase));
  var MergeAllObserver = (function() {
    function MergeAllObserver(o, g) {
      this.o = o;
      this.g = g;
      this.isStopped = false;
      this.done = false;
    }
    MergeAllObserver.prototype.onNext = function(innerSource) {
      if (this.isStopped) {
        return ;
      }
      var sad = new SingleAssignmentDisposable();
      this.g.add(sad);
      isPromise(innerSource) && (innerSource = observableFromPromise(innerSource));
      sad.setDisposable(innerSource.subscribe(new InnerObserver(this, this.g, sad)));
    };
    MergeAllObserver.prototype.onError = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.o.onError(e);
      }
    };
    MergeAllObserver.prototype.onCompleted = function() {
      if (!this.isStopped) {
        this.isStopped = true;
        this.done = true;
        this.g.length === 1 && this.o.onCompleted();
      }
    };
    MergeAllObserver.prototype.dispose = function() {
      this.isStopped = true;
    };
    MergeAllObserver.prototype.fail = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.o.onError(e);
        return true;
      }
      return false;
    };
    function InnerObserver(parent, g, sad) {
      this.parent = parent;
      this.g = g;
      this.sad = sad;
      this.isStopped = false;
    }
    InnerObserver.prototype.onNext = function(x) {
      if (!this.isStopped) {
        this.parent.o.onNext(x);
      }
    };
    InnerObserver.prototype.onError = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.parent.o.onError(e);
      }
    };
    InnerObserver.prototype.onCompleted = function() {
      if (!this.isStopped) {
        var parent = this.parent;
        this.isStopped = true;
        parent.g.remove(this.sad);
        parent.done && parent.g.length === 1 && parent.o.onCompleted();
      }
    };
    InnerObserver.prototype.dispose = function() {
      this.isStopped = true;
    };
    InnerObserver.prototype.fail = function(e) {
      if (!this.isStopped) {
        this.isStopped = true;
        this.parent.o.onError(e);
        return true;
      }
      return false;
    };
    return MergeAllObserver;
  }());
  observableProto.mergeAll = observableProto.mergeObservable = function() {
    return new MergeAllObservable(this);
  };
  var CompositeError = Rx.CompositeError = function(errors) {
    this.name = "NotImplementedError";
    this.innerErrors = errors;
    this.message = 'This contains multiple errors. Check the innerErrors';
    Error.call(this);
  };
  CompositeError.prototype = Error.prototype;
  Observable.mergeDelayError = function() {
    var args;
    if (Array.isArray(arguments[0])) {
      args = arguments[0];
    } else {
      var len = arguments.length;
      args = new Array(len);
      for (var i = 0; i < len; i++) {
        args[i] = arguments[i];
      }
    }
    var source = observableOf(null, args);
    return new AnonymousObservable(function(o) {
      var group = new CompositeDisposable(),
          m = new SingleAssignmentDisposable(),
          isStopped = false,
          errors = [];
      function setCompletion() {
        if (errors.length === 0) {
          o.onCompleted();
        } else if (errors.length === 1) {
          o.onError(errors[0]);
        } else {
          o.onError(new CompositeError(errors));
        }
      }
      group.add(m);
      m.setDisposable(source.subscribe(function(innerSource) {
        var innerSubscription = new SingleAssignmentDisposable();
        group.add(innerSubscription);
        isPromise(innerSource) && (innerSource = observableFromPromise(innerSource));
        innerSubscription.setDisposable(innerSource.subscribe(function(x) {
          o.onNext(x);
        }, function(e) {
          errors.push(e);
          group.remove(innerSubscription);
          isStopped && group.length === 1 && setCompletion();
        }, function() {
          group.remove(innerSubscription);
          isStopped && group.length === 1 && setCompletion();
        }));
      }, function(e) {
        errors.push(e);
        isStopped = true;
        group.length === 1 && setCompletion();
      }, function() {
        isStopped = true;
        group.length === 1 && setCompletion();
      }));
      return group;
    });
  };
  observableProto.onErrorResumeNext = function(second) {
    if (!second) {
      throw new Error('Second observable is required');
    }
    return onErrorResumeNext([this, second]);
  };
  var onErrorResumeNext = Observable.onErrorResumeNext = function() {
    var sources = [];
    if (Array.isArray(arguments[0])) {
      sources = arguments[0];
    } else {
      for (var i = 0,
          len = arguments.length; i < len; i++) {
        sources.push(arguments[i]);
      }
    }
    return new AnonymousObservable(function(observer) {
      var pos = 0,
          subscription = new SerialDisposable(),
          cancelable = immediateScheduler.scheduleRecursive(function(self) {
            var current,
                d;
            if (pos < sources.length) {
              current = sources[pos++];
              isPromise(current) && (current = observableFromPromise(current));
              d = new SingleAssignmentDisposable();
              subscription.setDisposable(d);
              d.setDisposable(current.subscribe(observer.onNext.bind(observer), self, self));
            } else {
              observer.onCompleted();
            }
          });
      return new CompositeDisposable(subscription, cancelable);
    });
  };
  observableProto.skipUntil = function(other) {
    var source = this;
    return new AnonymousObservable(function(o) {
      var isOpen = false;
      var disposables = new CompositeDisposable(source.subscribe(function(left) {
        isOpen && o.onNext(left);
      }, function(e) {
        o.onError(e);
      }, function() {
        isOpen && o.onCompleted();
      }));
      isPromise(other) && (other = observableFromPromise(other));
      var rightSubscription = new SingleAssignmentDisposable();
      disposables.add(rightSubscription);
      rightSubscription.setDisposable(other.subscribe(function() {
        isOpen = true;
        rightSubscription.dispose();
      }, function(e) {
        o.onError(e);
      }, function() {
        rightSubscription.dispose();
      }));
      return disposables;
    }, source);
  };
  observableProto['switch'] = observableProto.switchLatest = function() {
    var sources = this;
    return new AnonymousObservable(function(observer) {
      var hasLatest = false,
          innerSubscription = new SerialDisposable(),
          isStopped = false,
          latest = 0,
          subscription = sources.subscribe(function(innerSource) {
            var d = new SingleAssignmentDisposable(),
                id = ++latest;
            hasLatest = true;
            innerSubscription.setDisposable(d);
            isPromise(innerSource) && (innerSource = observableFromPromise(innerSource));
            d.setDisposable(innerSource.subscribe(function(x) {
              latest === id && observer.onNext(x);
            }, function(e) {
              latest === id && observer.onError(e);
            }, function() {
              if (latest === id) {
                hasLatest = false;
                isStopped && observer.onCompleted();
              }
            }));
          }, function(e) {
            observer.onError(e);
          }, function() {
            isStopped = true;
            !hasLatest && observer.onCompleted();
          });
      return new CompositeDisposable(subscription, innerSubscription);
    }, sources);
  };
  observableProto.takeUntil = function(other) {
    var source = this;
    return new AnonymousObservable(function(o) {
      isPromise(other) && (other = observableFromPromise(other));
      return new CompositeDisposable(source.subscribe(o), other.subscribe(function() {
        o.onCompleted();
      }, function(e) {
        o.onError(e);
      }, noop));
    }, source);
  };
  observableProto.withLatestFrom = function() {
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    var resultSelector = args.pop(),
        source = this;
    if (typeof source === 'undefined') {
      throw new Error('Source observable not found for withLatestFrom().');
    }
    if (typeof resultSelector !== 'function') {
      throw new Error('withLatestFrom() expects a resultSelector function.');
    }
    if (Array.isArray(args[0])) {
      args = args[0];
    }
    return new AnonymousObservable(function(observer) {
      var falseFactory = function() {
        return false;
      },
          n = args.length,
          hasValue = arrayInitialize(n, falseFactory),
          hasValueAll = false,
          values = new Array(n);
      var subscriptions = new Array(n + 1);
      for (var idx = 0; idx < n; idx++) {
        (function(i) {
          var other = args[i],
              sad = new SingleAssignmentDisposable();
          isPromise(other) && (other = observableFromPromise(other));
          sad.setDisposable(other.subscribe(function(x) {
            values[i] = x;
            hasValue[i] = true;
            hasValueAll = hasValue.every(identity);
          }, observer.onError.bind(observer), function() {}));
          subscriptions[i] = sad;
        }(idx));
      }
      var sad = new SingleAssignmentDisposable();
      sad.setDisposable(source.subscribe(function(x) {
        var res;
        var allValues = [x].concat(values);
        if (!hasValueAll)
          return ;
        try {
          res = resultSelector.apply(null, allValues);
        } catch (ex) {
          observer.onError(ex);
          return ;
        }
        observer.onNext(res);
      }, observer.onError.bind(observer), function() {
        observer.onCompleted();
      }));
      subscriptions[n] = sad;
      return new CompositeDisposable(subscriptions);
    }, this);
  };
  function zipArray(second, resultSelector) {
    var first = this;
    return new AnonymousObservable(function(observer) {
      var index = 0,
          len = second.length;
      return first.subscribe(function(left) {
        if (index < len) {
          var right = second[index++],
              result;
          try {
            result = resultSelector(left, right);
          } catch (e) {
            return observer.onError(e);
          }
          observer.onNext(result);
        } else {
          observer.onCompleted();
        }
      }, function(e) {
        observer.onError(e);
      }, function() {
        observer.onCompleted();
      });
    }, first);
  }
  function falseFactory() {
    return false;
  }
  function emptyArrayFactory() {
    return [];
  }
  observableProto.zip = function() {
    if (Array.isArray(arguments[0])) {
      return zipArray.apply(this, arguments);
    }
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    var parent = this,
        resultSelector = args.pop();
    args.unshift(parent);
    return new AnonymousObservable(function(observer) {
      var n = args.length,
          queues = arrayInitialize(n, emptyArrayFactory),
          isDone = arrayInitialize(n, falseFactory);
      function next(i) {
        var res,
            queuedValues;
        if (queues.every(function(x) {
          return x.length > 0;
        })) {
          try {
            queuedValues = queues.map(function(x) {
              return x.shift();
            });
            res = resultSelector.apply(parent, queuedValues);
          } catch (ex) {
            observer.onError(ex);
            return ;
          }
          observer.onNext(res);
        } else if (isDone.filter(function(x, j) {
          return j !== i;
        }).every(identity)) {
          observer.onCompleted();
        }
      }
      ;
      function done(i) {
        isDone[i] = true;
        if (isDone.every(function(x) {
          return x;
        })) {
          observer.onCompleted();
        }
      }
      var subscriptions = new Array(n);
      for (var idx = 0; idx < n; idx++) {
        (function(i) {
          var source = args[i],
              sad = new SingleAssignmentDisposable();
          isPromise(source) && (source = observableFromPromise(source));
          sad.setDisposable(source.subscribe(function(x) {
            queues[i].push(x);
            next(i);
          }, function(e) {
            observer.onError(e);
          }, function() {
            done(i);
          }));
          subscriptions[i] = sad;
        })(idx);
      }
      return new CompositeDisposable(subscriptions);
    }, parent);
  };
  Observable.zip = function() {
    var len = arguments.length,
        args = new Array(len);
    for (var i = 0; i < len; i++) {
      args[i] = arguments[i];
    }
    var first = args.shift();
    return first.zip.apply(first, args);
  };
  Observable.zipArray = function() {
    var sources;
    if (Array.isArray(arguments[0])) {
      sources = arguments[0];
    } else {
      var len = arguments.length;
      sources = new Array(len);
      for (var i = 0; i < len; i++) {
        sources[i] = arguments[i];
      }
    }
    return new AnonymousObservable(function(observer) {
      var n = sources.length,
          queues = arrayInitialize(n, function() {
            return [];
          }),
          isDone = arrayInitialize(n, function() {
            return false;
          });
      function next(i) {
        if (queues.every(function(x) {
          return x.length > 0;
        })) {
          var res = queues.map(function(x) {
            return x.shift();
          });
          observer.onNext(res);
        } else if (isDone.filter(function(x, j) {
          return j !== i;
        }).every(identity)) {
          observer.onCompleted();
          return ;
        }
      }
      ;
      function done(i) {
        isDone[i] = true;
        if (isDone.every(identity)) {
          observer.onCompleted();
          return ;
        }
      }
      var subscriptions = new Array(n);
      for (var idx = 0; idx < n; idx++) {
        (function(i) {
          subscriptions[i] = new SingleAssignmentDisposable();
          subscriptions[i].setDisposable(sources[i].subscribe(function(x) {
            queues[i].push(x);
            next(i);
          }, function(e) {
            observer.onError(e);
          }, function() {
            done(i);
          }));
        })(idx);
      }
      return new CompositeDisposable(subscriptions);
    });
  };
  observableProto.asObservable = function() {
    var source = this;
    return new AnonymousObservable(function(o) {
      return source.subscribe(o);
    }, this);
  };
  observableProto.bufferWithCount = function(count, skip) {
    if (typeof skip !== 'number') {
      skip = count;
    }
    return this.windowWithCount(count, skip).selectMany(function(x) {
      return x.toArray();
    }).where(function(x) {
      return x.length > 0;
    });
  };
  observableProto.dematerialize = function() {
    var source = this;
    return new AnonymousObservable(function(o) {
      return source.subscribe(function(x) {
        return x.accept(o);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, this);
  };
  observableProto.distinctUntilChanged = function(keySelector, comparer) {
    var source = this;
    comparer || (comparer = defaultComparer);
    return new AnonymousObservable(function(o) {
      var hasCurrentKey = false,
          currentKey;
      return source.subscribe(function(value) {
        var key = value;
        if (keySelector) {
          try {
            key = keySelector(value);
          } catch (e) {
            o.onError(e);
            return ;
          }
        }
        if (hasCurrentKey) {
          try {
            var comparerEquals = comparer(currentKey, key);
          } catch (e) {
            o.onError(e);
            return ;
          }
        }
        if (!hasCurrentKey || !comparerEquals) {
          hasCurrentKey = true;
          currentKey = key;
          o.onNext(value);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, this);
  };
  observableProto['do'] = observableProto.tap = observableProto.doAction = function(observerOrOnNext, onError, onCompleted) {
    var source = this,
        tapObserver = typeof observerOrOnNext === 'function' || typeof observerOrOnNext === 'undefined' ? observerCreate(observerOrOnNext || noop, onError || noop, onCompleted || noop) : observerOrOnNext;
    return new AnonymousObservable(function(observer) {
      return source.subscribe(function(x) {
        try {
          tapObserver.onNext(x);
        } catch (e) {
          observer.onError(e);
        }
        observer.onNext(x);
      }, function(err) {
        try {
          tapObserver.onError(err);
        } catch (e) {
          observer.onError(e);
        }
        observer.onError(err);
      }, function() {
        try {
          tapObserver.onCompleted();
        } catch (e) {
          observer.onError(e);
        }
        observer.onCompleted();
      });
    }, this);
  };
  observableProto.doOnNext = observableProto.tapOnNext = function(onNext, thisArg) {
    return this.tap(typeof thisArg !== 'undefined' ? function(x) {
      onNext.call(thisArg, x);
    } : onNext);
  };
  observableProto.doOnError = observableProto.tapOnError = function(onError, thisArg) {
    return this.tap(noop, typeof thisArg !== 'undefined' ? function(e) {
      onError.call(thisArg, e);
    } : onError);
  };
  observableProto.doOnCompleted = observableProto.tapOnCompleted = function(onCompleted, thisArg) {
    return this.tap(noop, null, typeof thisArg !== 'undefined' ? function() {
      onCompleted.call(thisArg);
    } : onCompleted);
  };
  observableProto['finally'] = observableProto.ensure = function(action) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var subscription;
      try {
        subscription = source.subscribe(observer);
      } catch (e) {
        action();
        throw e;
      }
      return disposableCreate(function() {
        try {
          subscription.dispose();
        } catch (e) {
          throw e;
        } finally {
          action();
        }
      });
    }, this);
  };
  observableProto.finallyAction = function(action) {
    return this.ensure(action);
  };
  observableProto.ignoreElements = function() {
    var source = this;
    return new AnonymousObservable(function(o) {
      return source.subscribe(noop, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.materialize = function() {
    var source = this;
    return new AnonymousObservable(function(observer) {
      return source.subscribe(function(value) {
        observer.onNext(notificationCreateOnNext(value));
      }, function(e) {
        observer.onNext(notificationCreateOnError(e));
        observer.onCompleted();
      }, function() {
        observer.onNext(notificationCreateOnCompleted());
        observer.onCompleted();
      });
    }, source);
  };
  observableProto.repeat = function(repeatCount) {
    return enumerableRepeat(this, repeatCount).concat();
  };
  observableProto.retry = function(retryCount) {
    return enumerableRepeat(this, retryCount).catchError();
  };
  observableProto.retryWhen = function(notifier) {
    return enumerableRepeat(this).catchErrorWhen(notifier);
  };
  observableProto.scan = function() {
    var hasSeed = false,
        seed,
        accumulator,
        source = this;
    if (arguments.length === 2) {
      hasSeed = true;
      seed = arguments[0];
      accumulator = arguments[1];
    } else {
      accumulator = arguments[0];
    }
    return new AnonymousObservable(function(o) {
      var hasAccumulation,
          accumulation,
          hasValue;
      return source.subscribe(function(x) {
        !hasValue && (hasValue = true);
        try {
          if (hasAccumulation) {
            accumulation = accumulator(accumulation, x);
          } else {
            accumulation = hasSeed ? accumulator(seed, x) : x;
            hasAccumulation = true;
          }
        } catch (e) {
          o.onError(e);
          return ;
        }
        o.onNext(accumulation);
      }, function(e) {
        o.onError(e);
      }, function() {
        !hasValue && hasSeed && o.onNext(seed);
        o.onCompleted();
      });
    }, source);
  };
  observableProto.skipLast = function(count) {
    if (count < 0) {
      throw new ArgumentOutOfRangeError();
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        q.push(x);
        q.length > count && o.onNext(q.shift());
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.startWith = function() {
    var values,
        scheduler,
        start = 0;
    if (!!arguments.length && isScheduler(arguments[0])) {
      scheduler = arguments[0];
      start = 1;
    } else {
      scheduler = immediateScheduler;
    }
    for (var args = [],
        i = start,
        len = arguments.length; i < len; i++) {
      args.push(arguments[i]);
    }
    return enumerableOf([observableFromArray(args, scheduler), this]).concat();
  };
  observableProto.takeLast = function(count) {
    if (count < 0) {
      throw new ArgumentOutOfRangeError();
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        q.push(x);
        q.length > count && q.shift();
      }, function(e) {
        o.onError(e);
      }, function() {
        while (q.length > 0) {
          o.onNext(q.shift());
        }
        o.onCompleted();
      });
    }, source);
  };
  observableProto.takeLastBuffer = function(count) {
    var source = this;
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        q.push(x);
        q.length > count && q.shift();
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(q);
        o.onCompleted();
      });
    }, source);
  };
  observableProto.windowWithCount = function(count, skip) {
    var source = this;
    +count || (count = 0);
    Math.abs(count) === Infinity && (count = 0);
    if (count <= 0) {
      throw new ArgumentOutOfRangeError();
    }
    skip == null && (skip = count);
    +skip || (skip = 0);
    Math.abs(skip) === Infinity && (skip = 0);
    if (skip <= 0) {
      throw new ArgumentOutOfRangeError();
    }
    return new AnonymousObservable(function(observer) {
      var m = new SingleAssignmentDisposable(),
          refCountDisposable = new RefCountDisposable(m),
          n = 0,
          q = [];
      function createWindow() {
        var s = new Subject();
        q.push(s);
        observer.onNext(addRef(s, refCountDisposable));
      }
      createWindow();
      m.setDisposable(source.subscribe(function(x) {
        for (var i = 0,
            len = q.length; i < len; i++) {
          q[i].onNext(x);
        }
        var c = n - count + 1;
        c >= 0 && c % skip === 0 && q.shift().onCompleted();
        ++n % skip === 0 && createWindow();
      }, function(e) {
        while (q.length > 0) {
          q.shift().onError(e);
        }
        observer.onError(e);
      }, function() {
        while (q.length > 0) {
          q.shift().onCompleted();
        }
        observer.onCompleted();
      }));
      return refCountDisposable;
    }, source);
  };
  function concatMap(source, selector, thisArg) {
    var selectorFunc = bindCallback(selector, thisArg, 3);
    return source.map(function(x, i) {
      var result = selectorFunc(x, i, source);
      isPromise(result) && (result = observableFromPromise(result));
      (isArrayLike(result) || isIterable(result)) && (result = observableFrom(result));
      return result;
    }).concatAll();
  }
  observableProto.selectConcat = observableProto.concatMap = function(selector, resultSelector, thisArg) {
    if (isFunction(selector) && isFunction(resultSelector)) {
      return this.concatMap(function(x, i) {
        var selectorResult = selector(x, i);
        isPromise(selectorResult) && (selectorResult = observableFromPromise(selectorResult));
        (isArrayLike(selectorResult) || isIterable(selectorResult)) && (selectorResult = observableFrom(selectorResult));
        return selectorResult.map(function(y, i2) {
          return resultSelector(x, y, i, i2);
        });
      });
    }
    return isFunction(selector) ? concatMap(this, selector, thisArg) : concatMap(this, function() {
      return selector;
    });
  };
  observableProto.concatMapObserver = observableProto.selectConcatObserver = function(onNext, onError, onCompleted, thisArg) {
    var source = this,
        onNextFunc = bindCallback(onNext, thisArg, 2),
        onErrorFunc = bindCallback(onError, thisArg, 1),
        onCompletedFunc = bindCallback(onCompleted, thisArg, 0);
    return new AnonymousObservable(function(observer) {
      var index = 0;
      return source.subscribe(function(x) {
        var result;
        try {
          result = onNextFunc(x, index++);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
      }, function(err) {
        var result;
        try {
          result = onErrorFunc(err);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
        observer.onCompleted();
      }, function() {
        var result;
        try {
          result = onCompletedFunc();
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
        observer.onCompleted();
      });
    }, this).concatAll();
  };
  observableProto.defaultIfEmpty = function(defaultValue) {
    var source = this;
    defaultValue === undefined && (defaultValue = null);
    return new AnonymousObservable(function(observer) {
      var found = false;
      return source.subscribe(function(x) {
        found = true;
        observer.onNext(x);
      }, function(e) {
        observer.onError(e);
      }, function() {
        !found && observer.onNext(defaultValue);
        observer.onCompleted();
      });
    }, source);
  };
  function arrayIndexOfComparer(array, item, comparer) {
    for (var i = 0,
        len = array.length; i < len; i++) {
      if (comparer(array[i], item)) {
        return i;
      }
    }
    return -1;
  }
  function HashSet(comparer) {
    this.comparer = comparer;
    this.set = [];
  }
  HashSet.prototype.push = function(value) {
    var retValue = arrayIndexOfComparer(this.set, value, this.comparer) === -1;
    retValue && this.set.push(value);
    return retValue;
  };
  observableProto.distinct = function(keySelector, comparer) {
    var source = this;
    comparer || (comparer = defaultComparer);
    return new AnonymousObservable(function(o) {
      var hashSet = new HashSet(comparer);
      return source.subscribe(function(x) {
        var key = x;
        if (keySelector) {
          try {
            key = keySelector(x);
          } catch (e) {
            o.onError(e);
            return ;
          }
        }
        hashSet.push(key) && o.onNext(x);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, this);
  };
  observableProto.groupBy = function(keySelector, elementSelector, comparer) {
    return this.groupByUntil(keySelector, elementSelector, observableNever, comparer);
  };
  observableProto.groupByUntil = function(keySelector, elementSelector, durationSelector, comparer) {
    var source = this;
    elementSelector || (elementSelector = identity);
    comparer || (comparer = defaultComparer);
    return new AnonymousObservable(function(observer) {
      function handleError(e) {
        return function(item) {
          item.onError(e);
        };
      }
      var map = new Dictionary(0, comparer),
          groupDisposable = new CompositeDisposable(),
          refCountDisposable = new RefCountDisposable(groupDisposable);
      groupDisposable.add(source.subscribe(function(x) {
        var key;
        try {
          key = keySelector(x);
        } catch (e) {
          map.getValues().forEach(handleError(e));
          observer.onError(e);
          return ;
        }
        var fireNewMapEntry = false,
            writer = map.tryGetValue(key);
        if (!writer) {
          writer = new Subject();
          map.set(key, writer);
          fireNewMapEntry = true;
        }
        if (fireNewMapEntry) {
          var group = new GroupedObservable(key, writer, refCountDisposable),
              durationGroup = new GroupedObservable(key, writer);
          try {
            duration = durationSelector(durationGroup);
          } catch (e) {
            map.getValues().forEach(handleError(e));
            observer.onError(e);
            return ;
          }
          observer.onNext(group);
          var md = new SingleAssignmentDisposable();
          groupDisposable.add(md);
          var expire = function() {
            map.remove(key) && writer.onCompleted();
            groupDisposable.remove(md);
          };
          md.setDisposable(duration.take(1).subscribe(noop, function(exn) {
            map.getValues().forEach(handleError(exn));
            observer.onError(exn);
          }, expire));
        }
        var element;
        try {
          element = elementSelector(x);
        } catch (e) {
          map.getValues().forEach(handleError(e));
          observer.onError(e);
          return ;
        }
        writer.onNext(element);
      }, function(ex) {
        map.getValues().forEach(handleError(ex));
        observer.onError(ex);
      }, function() {
        map.getValues().forEach(function(item) {
          item.onCompleted();
        });
        observer.onCompleted();
      }));
      return refCountDisposable;
    }, source);
  };
  var MapObservable = (function(__super__) {
    inherits(MapObservable, __super__);
    function MapObservable(source, selector, thisArg) {
      this.source = source;
      this.selector = bindCallback(selector, thisArg, 3);
      __super__.call(this);
    }
    MapObservable.prototype.internalMap = function(selector, thisArg) {
      var self = this;
      return new MapObservable(this.source, function(x, i, o) {
        return selector(self.selector(x, i, o), i, o);
      }, thisArg);
    };
    MapObservable.prototype.subscribeCore = function(observer) {
      return this.source.subscribe(new MapObserver(observer, this.selector, this));
    };
    return MapObservable;
  }(ObservableBase));
  function MapObserver(observer, selector, source) {
    this.observer = observer;
    this.selector = selector;
    this.source = source;
    this.i = 0;
    this.isStopped = false;
  }
  MapObserver.prototype.onNext = function(x) {
    if (this.isStopped) {
      return ;
    }
    var result = tryCatch(this.selector).call(this, x, this.i++, this.source);
    if (result === errorObj) {
      return this.observer.onError(result.e);
    }
    this.observer.onNext(result);
  };
  MapObserver.prototype.onError = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
    }
  };
  MapObserver.prototype.onCompleted = function() {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onCompleted();
    }
  };
  MapObserver.prototype.dispose = function() {
    this.isStopped = true;
  };
  MapObserver.prototype.fail = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
      return true;
    }
    return false;
  };
  observableProto.map = observableProto.select = function(selector, thisArg) {
    var selectorFn = typeof selector === 'function' ? selector : function() {
      return selector;
    };
    return this instanceof MapObservable ? this.internalMap(selectorFn, thisArg) : new MapObservable(this, selectorFn, thisArg);
  };
  observableProto.pluck = function() {
    var args = arguments,
        len = arguments.length;
    if (len === 0) {
      throw new Error('List of properties cannot be empty.');
    }
    return this.map(function(x) {
      var currentProp = x;
      for (var i = 0; i < len; i++) {
        var p = currentProp[args[i]];
        if (typeof p !== 'undefined') {
          currentProp = p;
        } else {
          return undefined;
        }
      }
      return currentProp;
    });
  };
  function flatMap(source, selector, thisArg) {
    var selectorFunc = bindCallback(selector, thisArg, 3);
    return source.map(function(x, i) {
      var result = selectorFunc(x, i, source);
      isPromise(result) && (result = observableFromPromise(result));
      (isArrayLike(result) || isIterable(result)) && (result = observableFrom(result));
      return result;
    }).mergeAll();
  }
  observableProto.selectMany = observableProto.flatMap = function(selector, resultSelector, thisArg) {
    if (isFunction(selector) && isFunction(resultSelector)) {
      return this.flatMap(function(x, i) {
        var selectorResult = selector(x, i);
        isPromise(selectorResult) && (selectorResult = observableFromPromise(selectorResult));
        (isArrayLike(selectorResult) || isIterable(selectorResult)) && (selectorResult = observableFrom(selectorResult));
        return selectorResult.map(function(y, i2) {
          return resultSelector(x, y, i, i2);
        });
      }, thisArg);
    }
    return isFunction(selector) ? flatMap(this, selector, thisArg) : flatMap(this, function() {
      return selector;
    });
  };
  observableProto.flatMapObserver = observableProto.selectManyObserver = function(onNext, onError, onCompleted, thisArg) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var index = 0;
      return source.subscribe(function(x) {
        var result;
        try {
          result = onNext.call(thisArg, x, index++);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
      }, function(err) {
        var result;
        try {
          result = onError.call(thisArg, err);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
        observer.onCompleted();
      }, function() {
        var result;
        try {
          result = onCompleted.call(thisArg);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(result) && (result = observableFromPromise(result));
        observer.onNext(result);
        observer.onCompleted();
      });
    }, source).mergeAll();
  };
  observableProto.selectSwitch = observableProto.flatMapLatest = observableProto.switchMap = function(selector, thisArg) {
    return this.select(selector, thisArg).switchLatest();
  };
  observableProto.skip = function(count) {
    if (count < 0) {
      throw new ArgumentOutOfRangeError();
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var remaining = count;
      return source.subscribe(function(x) {
        if (remaining <= 0) {
          o.onNext(x);
        } else {
          remaining--;
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.skipWhile = function(predicate, thisArg) {
    var source = this,
        callback = bindCallback(predicate, thisArg, 3);
    return new AnonymousObservable(function(o) {
      var i = 0,
          running = false;
      return source.subscribe(function(x) {
        if (!running) {
          try {
            running = !callback(x, i++, source);
          } catch (e) {
            o.onError(e);
            return ;
          }
        }
        running && o.onNext(x);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.take = function(count, scheduler) {
    if (count < 0) {
      throw new ArgumentOutOfRangeError();
    }
    if (count === 0) {
      return observableEmpty(scheduler);
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var remaining = count;
      return source.subscribe(function(x) {
        if (remaining-- > 0) {
          o.onNext(x);
          remaining === 0 && o.onCompleted();
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.takeWhile = function(predicate, thisArg) {
    var source = this,
        callback = bindCallback(predicate, thisArg, 3);
    return new AnonymousObservable(function(o) {
      var i = 0,
          running = true;
      return source.subscribe(function(x) {
        if (running) {
          try {
            running = callback(x, i++, source);
          } catch (e) {
            o.onError(e);
            return ;
          }
          if (running) {
            o.onNext(x);
          } else {
            o.onCompleted();
          }
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  var FilterObservable = (function(__super__) {
    inherits(FilterObservable, __super__);
    function FilterObservable(source, predicate, thisArg) {
      this.source = source;
      this.predicate = bindCallback(predicate, thisArg, 3);
      __super__.call(this);
    }
    FilterObservable.prototype.subscribeCore = function(observer) {
      return this.source.subscribe(new FilterObserver(observer, this.predicate, this));
    };
    FilterObservable.prototype.internalFilter = function(predicate, thisArg) {
      var self = this;
      return new FilterObservable(this.source, function(x, i, o) {
        return self.predicate(x, i, o) && predicate(x, i, o);
      }, thisArg);
    };
    return FilterObservable;
  }(ObservableBase));
  function FilterObserver(observer, predicate, source) {
    this.observer = observer;
    this.predicate = predicate;
    this.source = source;
    this.i = 0;
    this.isStopped = false;
  }
  FilterObserver.prototype.onNext = function(x) {
    if (this.isStopped) {
      return ;
    }
    var shouldYield = tryCatch(this.predicate).call(this, x, this.i++, this.source);
    if (shouldYield === errorObj) {
      return this.observer.onError(shouldYield.e);
    }
    shouldYield && this.observer.onNext(x);
  };
  FilterObserver.prototype.onError = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
    }
  };
  FilterObserver.prototype.onCompleted = function() {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onCompleted();
    }
  };
  FilterObserver.prototype.dispose = function() {
    this.isStopped = true;
  };
  FilterObserver.prototype.fail = function(e) {
    if (!this.isStopped) {
      this.isStopped = true;
      this.observer.onError(e);
      return true;
    }
    return false;
  };
  observableProto.filter = observableProto.where = function(predicate, thisArg) {
    return this instanceof FilterObservable ? this.internalFilter(predicate, thisArg) : new FilterObservable(this, predicate, thisArg);
  };
  function extremaBy(source, keySelector, comparer) {
    return new AnonymousObservable(function(o) {
      var hasValue = false,
          lastKey = null,
          list = [];
      return source.subscribe(function(x) {
        var comparison,
            key;
        try {
          key = keySelector(x);
        } catch (ex) {
          o.onError(ex);
          return ;
        }
        comparison = 0;
        if (!hasValue) {
          hasValue = true;
          lastKey = key;
        } else {
          try {
            comparison = comparer(key, lastKey);
          } catch (ex1) {
            o.onError(ex1);
            return ;
          }
        }
        if (comparison > 0) {
          lastKey = key;
          list = [];
        }
        if (comparison >= 0) {
          list.push(x);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(list);
        o.onCompleted();
      });
    }, source);
  }
  function firstOnly(x) {
    if (x.length === 0) {
      throw new EmptyError();
    }
    return x[0];
  }
  observableProto.aggregate = function() {
    var hasSeed = false,
        accumulator,
        seed,
        source = this;
    if (arguments.length === 2) {
      hasSeed = true;
      seed = arguments[0];
      accumulator = arguments[1];
    } else {
      accumulator = arguments[0];
    }
    return new AnonymousObservable(function(o) {
      var hasAccumulation,
          accumulation,
          hasValue;
      return source.subscribe(function(x) {
        !hasValue && (hasValue = true);
        try {
          if (hasAccumulation) {
            accumulation = accumulator(accumulation, x);
          } else {
            accumulation = hasSeed ? accumulator(seed, x) : x;
            hasAccumulation = true;
          }
        } catch (e) {
          return o.onError(e);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        hasValue && o.onNext(accumulation);
        !hasValue && hasSeed && o.onNext(seed);
        !hasValue && !hasSeed && o.onError(new EmptyError());
        o.onCompleted();
      });
    }, source);
  };
  observableProto.reduce = function(accumulator) {
    var hasSeed = false,
        seed,
        source = this;
    if (arguments.length === 2) {
      hasSeed = true;
      seed = arguments[1];
    }
    return new AnonymousObservable(function(o) {
      var hasAccumulation,
          accumulation,
          hasValue;
      return source.subscribe(function(x) {
        !hasValue && (hasValue = true);
        try {
          if (hasAccumulation) {
            accumulation = accumulator(accumulation, x);
          } else {
            accumulation = hasSeed ? accumulator(seed, x) : x;
            hasAccumulation = true;
          }
        } catch (e) {
          return o.onError(e);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        hasValue && o.onNext(accumulation);
        !hasValue && hasSeed && o.onNext(seed);
        !hasValue && !hasSeed && o.onError(new EmptyError());
        o.onCompleted();
      });
    }, source);
  };
  observableProto.some = function(predicate, thisArg) {
    var source = this;
    return predicate ? source.filter(predicate, thisArg).some() : new AnonymousObservable(function(observer) {
      return source.subscribe(function() {
        observer.onNext(true);
        observer.onCompleted();
      }, function(e) {
        observer.onError(e);
      }, function() {
        observer.onNext(false);
        observer.onCompleted();
      });
    }, source);
  };
  observableProto.any = function() {
    return this.some.apply(this, arguments);
  };
  observableProto.isEmpty = function() {
    return this.any().map(not);
  };
  observableProto.every = function(predicate, thisArg) {
    return this.filter(function(v) {
      return !predicate(v);
    }, thisArg).some().map(not);
  };
  observableProto.all = function() {
    return this.every.apply(this, arguments);
  };
  observableProto.includes = function(searchElement, fromIndex) {
    var source = this;
    function comparer(a, b) {
      return (a === 0 && b === 0) || (a === b || (isNaN(a) && isNaN(b)));
    }
    return new AnonymousObservable(function(o) {
      var i = 0,
          n = +fromIndex || 0;
      Math.abs(n) === Infinity && (n = 0);
      if (n < 0) {
        o.onNext(false);
        o.onCompleted();
        return disposableEmpty;
      }
      return source.subscribe(function(x) {
        if (i++ >= n && comparer(x, searchElement)) {
          o.onNext(true);
          o.onCompleted();
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(false);
        o.onCompleted();
      });
    }, this);
  };
  observableProto.contains = function(searchElement, fromIndex) {
    observableProto.includes(searchElement, fromIndex);
  };
  observableProto.count = function(predicate, thisArg) {
    return predicate ? this.filter(predicate, thisArg).count() : this.reduce(function(count) {
      return count + 1;
    }, 0);
  };
  observableProto.indexOf = function(searchElement, fromIndex) {
    var source = this;
    return new AnonymousObservable(function(o) {
      var i = 0,
          n = +fromIndex || 0;
      Math.abs(n) === Infinity && (n = 0);
      if (n < 0) {
        o.onNext(-1);
        o.onCompleted();
        return disposableEmpty;
      }
      return source.subscribe(function(x) {
        if (i >= n && x === searchElement) {
          o.onNext(i);
          o.onCompleted();
        }
        i++;
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(-1);
        o.onCompleted();
      });
    }, source);
  };
  observableProto.sum = function(keySelector, thisArg) {
    return keySelector && isFunction(keySelector) ? this.map(keySelector, thisArg).sum() : this.reduce(function(prev, curr) {
      return prev + curr;
    }, 0);
  };
  observableProto.minBy = function(keySelector, comparer) {
    comparer || (comparer = defaultSubComparer);
    return extremaBy(this, keySelector, function(x, y) {
      return comparer(x, y) * -1;
    });
  };
  observableProto.min = function(comparer) {
    return this.minBy(identity, comparer).map(function(x) {
      return firstOnly(x);
    });
  };
  observableProto.maxBy = function(keySelector, comparer) {
    comparer || (comparer = defaultSubComparer);
    return extremaBy(this, keySelector, comparer);
  };
  observableProto.max = function(comparer) {
    return this.maxBy(identity, comparer).map(function(x) {
      return firstOnly(x);
    });
  };
  observableProto.average = function(keySelector, thisArg) {
    return keySelector && isFunction(keySelector) ? this.map(keySelector, thisArg).average() : this.reduce(function(prev, cur) {
      return {
        sum: prev.sum + cur,
        count: prev.count + 1
      };
    }, {
      sum: 0,
      count: 0
    }).map(function(s) {
      if (s.count === 0) {
        throw new EmptyError();
      }
      return s.sum / s.count;
    });
  };
  observableProto.sequenceEqual = function(second, comparer) {
    var first = this;
    comparer || (comparer = defaultComparer);
    return new AnonymousObservable(function(o) {
      var donel = false,
          doner = false,
          ql = [],
          qr = [];
      var subscription1 = first.subscribe(function(x) {
        var equal,
            v;
        if (qr.length > 0) {
          v = qr.shift();
          try {
            equal = comparer(v, x);
          } catch (e) {
            o.onError(e);
            return ;
          }
          if (!equal) {
            o.onNext(false);
            o.onCompleted();
          }
        } else if (doner) {
          o.onNext(false);
          o.onCompleted();
        } else {
          ql.push(x);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        donel = true;
        if (ql.length === 0) {
          if (qr.length > 0) {
            o.onNext(false);
            o.onCompleted();
          } else if (doner) {
            o.onNext(true);
            o.onCompleted();
          }
        }
      });
      (isArrayLike(second) || isIterable(second)) && (second = observableFrom(second));
      isPromise(second) && (second = observableFromPromise(second));
      var subscription2 = second.subscribe(function(x) {
        var equal;
        if (ql.length > 0) {
          var v = ql.shift();
          try {
            equal = comparer(v, x);
          } catch (exception) {
            o.onError(exception);
            return ;
          }
          if (!equal) {
            o.onNext(false);
            o.onCompleted();
          }
        } else if (donel) {
          o.onNext(false);
          o.onCompleted();
        } else {
          qr.push(x);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        doner = true;
        if (qr.length === 0) {
          if (ql.length > 0) {
            o.onNext(false);
            o.onCompleted();
          } else if (donel) {
            o.onNext(true);
            o.onCompleted();
          }
        }
      });
      return new CompositeDisposable(subscription1, subscription2);
    }, first);
  };
  function elementAtOrDefault(source, index, hasDefault, defaultValue) {
    if (index < 0) {
      throw new ArgumentOutOfRangeError();
    }
    return new AnonymousObservable(function(o) {
      var i = index;
      return source.subscribe(function(x) {
        if (i-- === 0) {
          o.onNext(x);
          o.onCompleted();
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        if (!hasDefault) {
          o.onError(new ArgumentOutOfRangeError());
        } else {
          o.onNext(defaultValue);
          o.onCompleted();
        }
      });
    }, source);
  }
  observableProto.elementAt = function(index) {
    return elementAtOrDefault(this, index, false);
  };
  observableProto.elementAtOrDefault = function(index, defaultValue) {
    return elementAtOrDefault(this, index, true, defaultValue);
  };
  function singleOrDefaultAsync(source, hasDefault, defaultValue) {
    return new AnonymousObservable(function(o) {
      var value = defaultValue,
          seenValue = false;
      return source.subscribe(function(x) {
        if (seenValue) {
          o.onError(new Error('Sequence contains more than one element'));
        } else {
          value = x;
          seenValue = true;
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        if (!seenValue && !hasDefault) {
          o.onError(new EmptyError());
        } else {
          o.onNext(value);
          o.onCompleted();
        }
      });
    }, source);
  }
  observableProto.single = function(predicate, thisArg) {
    return predicate && isFunction(predicate) ? this.where(predicate, thisArg).single() : singleOrDefaultAsync(this, false);
  };
  observableProto.singleOrDefault = function(predicate, defaultValue, thisArg) {
    return predicate && isFunction(predicate) ? this.filter(predicate, thisArg).singleOrDefault(null, defaultValue) : singleOrDefaultAsync(this, true, defaultValue);
  };
  function firstOrDefaultAsync(source, hasDefault, defaultValue) {
    return new AnonymousObservable(function(o) {
      return source.subscribe(function(x) {
        o.onNext(x);
        o.onCompleted();
      }, function(e) {
        o.onError(e);
      }, function() {
        if (!hasDefault) {
          o.onError(new EmptyError());
        } else {
          o.onNext(defaultValue);
          o.onCompleted();
        }
      });
    }, source);
  }
  observableProto.first = function(predicate, thisArg) {
    return predicate ? this.where(predicate, thisArg).first() : firstOrDefaultAsync(this, false);
  };
  observableProto.firstOrDefault = function(predicate, defaultValue, thisArg) {
    return predicate ? this.where(predicate).firstOrDefault(null, defaultValue) : firstOrDefaultAsync(this, true, defaultValue);
  };
  function lastOrDefaultAsync(source, hasDefault, defaultValue) {
    return new AnonymousObservable(function(o) {
      var value = defaultValue,
          seenValue = false;
      return source.subscribe(function(x) {
        value = x;
        seenValue = true;
      }, function(e) {
        o.onError(e);
      }, function() {
        if (!seenValue && !hasDefault) {
          o.onError(new EmptyError());
        } else {
          o.onNext(value);
          o.onCompleted();
        }
      });
    }, source);
  }
  observableProto.last = function(predicate, thisArg) {
    return predicate ? this.where(predicate, thisArg).last() : lastOrDefaultAsync(this, false);
  };
  observableProto.lastOrDefault = function(predicate, defaultValue, thisArg) {
    return predicate ? this.where(predicate, thisArg).lastOrDefault(null, defaultValue) : lastOrDefaultAsync(this, true, defaultValue);
  };
  function findValue(source, predicate, thisArg, yieldIndex) {
    var callback = bindCallback(predicate, thisArg, 3);
    return new AnonymousObservable(function(o) {
      var i = 0;
      return source.subscribe(function(x) {
        var shouldRun;
        try {
          shouldRun = callback(x, i, source);
        } catch (e) {
          o.onError(e);
          return ;
        }
        if (shouldRun) {
          o.onNext(yieldIndex ? i : x);
          o.onCompleted();
        } else {
          i++;
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(yieldIndex ? -1 : undefined);
        o.onCompleted();
      });
    }, source);
  }
  observableProto.find = function(predicate, thisArg) {
    return findValue(this, predicate, thisArg, false);
  };
  observableProto.findIndex = function(predicate, thisArg) {
    return findValue(this, predicate, thisArg, true);
  };
  observableProto.toSet = function() {
    if (typeof root.Set === 'undefined') {
      throw new TypeError();
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var s = new root.Set();
      return source.subscribe(function(x) {
        s.add(x);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(s);
        o.onCompleted();
      });
    }, source);
  };
  observableProto.toMap = function(keySelector, elementSelector) {
    if (typeof root.Map === 'undefined') {
      throw new TypeError();
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var m = new root.Map();
      return source.subscribe(function(x) {
        var key;
        try {
          key = keySelector(x);
        } catch (e) {
          o.onError(e);
          return ;
        }
        var element = x;
        if (elementSelector) {
          try {
            element = elementSelector(x);
          } catch (e) {
            o.onError(e);
            return ;
          }
        }
        m.set(key, element);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onNext(m);
        o.onCompleted();
      });
    }, source);
  };
  var fnString = 'function',
      throwString = 'throw',
      isObject = Rx.internals.isObject;
  function toThunk(obj, ctx) {
    if (Array.isArray(obj)) {
      return objectToThunk.call(ctx, obj);
    }
    if (isGeneratorFunction(obj)) {
      return observableSpawn(obj.call(ctx));
    }
    if (isGenerator(obj)) {
      return observableSpawn(obj);
    }
    if (isObservable(obj)) {
      return observableToThunk(obj);
    }
    if (isPromise(obj)) {
      return promiseToThunk(obj);
    }
    if (typeof obj === fnString) {
      return obj;
    }
    if (isObject(obj) || Array.isArray(obj)) {
      return objectToThunk.call(ctx, obj);
    }
    return obj;
  }
  function objectToThunk(obj) {
    var ctx = this;
    return function(done) {
      var keys = Object.keys(obj),
          pending = keys.length,
          results = new obj.constructor(),
          finished;
      if (!pending) {
        timeoutScheduler.schedule(function() {
          done(null, results);
        });
        return ;
      }
      for (var i = 0,
          len = keys.length; i < len; i++) {
        run(obj[keys[i]], keys[i]);
      }
      function run(fn, key) {
        if (finished) {
          return ;
        }
        try {
          fn = toThunk(fn, ctx);
          if (typeof fn !== fnString) {
            results[key] = fn;
            return --pending || done(null, results);
          }
          fn.call(ctx, function(err, res) {
            if (finished) {
              return ;
            }
            if (err) {
              finished = true;
              return done(err);
            }
            results[key] = res;
            --pending || done(null, results);
          });
        } catch (e) {
          finished = true;
          done(e);
        }
      }
    };
  }
  function observableToThunk(observable) {
    return function(fn) {
      var value,
          hasValue = false;
      observable.subscribe(function(v) {
        value = v;
        hasValue = true;
      }, fn, function() {
        hasValue && fn(null, value);
      });
    };
  }
  function promiseToThunk(promise) {
    return function(fn) {
      promise.then(function(res) {
        fn(null, res);
      }, fn);
    };
  }
  function isObservable(obj) {
    return obj && typeof obj.subscribe === fnString;
  }
  function isGeneratorFunction(obj) {
    return obj && obj.constructor && obj.constructor.name === 'GeneratorFunction';
  }
  function isGenerator(obj) {
    return obj && typeof obj.next === fnString && typeof obj[throwString] === fnString;
  }
  var observableSpawn = Rx.spawn = function(fn) {
    var isGenFun = isGeneratorFunction(fn);
    return function(done) {
      var ctx = this,
          gen = fn;
      if (isGenFun) {
        for (var args = [],
            i = 0,
            len = arguments.length; i < len; i++) {
          args.push(arguments[i]);
        }
        var len = args.length,
            hasCallback = len && typeof args[len - 1] === fnString;
        done = hasCallback ? args.pop() : handleError;
        gen = fn.apply(this, args);
      } else {
        done = done || handleError;
      }
      next();
      function exit(err, res) {
        timeoutScheduler.schedule(done.bind(ctx, err, res));
      }
      function next(err, res) {
        var ret;
        if (arguments.length > 2) {
          for (var res = [],
              i = 1,
              len = arguments.length; i < len; i++) {
            res.push(arguments[i]);
          }
        }
        if (err) {
          try {
            ret = gen[throwString](err);
          } catch (e) {
            return exit(e);
          }
        }
        if (!err) {
          try {
            ret = gen.next(res);
          } catch (e) {
            return exit(e);
          }
        }
        if (ret.done) {
          return exit(null, ret.value);
        }
        ret.value = toThunk(ret.value, ctx);
        if (typeof ret.value === fnString) {
          var called = false;
          try {
            ret.value.call(ctx, function() {
              if (called) {
                return ;
              }
              called = true;
              next.apply(ctx, arguments);
            });
          } catch (e) {
            timeoutScheduler.schedule(function() {
              if (called) {
                return ;
              }
              called = true;
              next.call(ctx, e);
            });
          }
          return ;
        }
        next(new TypeError('Rx.spawn only supports a function, Promise, Observable, Object or Array.'));
      }
    };
  };
  function handleError(err) {
    if (!err) {
      return ;
    }
    timeoutScheduler.schedule(function() {
      throw err;
    });
  }
  Observable.start = function(func, context, scheduler) {
    return observableToAsync(func, context, scheduler)();
  };
  var observableToAsync = Observable.toAsync = function(func, context, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return function() {
      var args = arguments,
          subject = new AsyncSubject();
      scheduler.schedule(function() {
        var result;
        try {
          result = func.apply(context, args);
        } catch (e) {
          subject.onError(e);
          return ;
        }
        subject.onNext(result);
        subject.onCompleted();
      });
      return subject.asObservable();
    };
  };
  Observable.fromCallback = function(func, context, selector) {
    return function() {
      for (var args = [],
          i = 0,
          len = arguments.length; i < len; i++) {
        args.push(arguments[i]);
      }
      return new AnonymousObservable(function(observer) {
        function handler() {
          var results = arguments;
          if (selector) {
            try {
              results = selector(results);
            } catch (e) {
              return observer.onError(e);
            }
            observer.onNext(results);
          } else {
            if (results.length <= 1) {
              observer.onNext.apply(observer, results);
            } else {
              observer.onNext(results);
            }
          }
          observer.onCompleted();
        }
        args.push(handler);
        func.apply(context, args);
      }).publishLast().refCount();
    };
  };
  Observable.fromNodeCallback = function(func, context, selector) {
    return function() {
      var len = arguments.length,
          args = new Array(len);
      for (var i = 0; i < len; i++) {
        args[i] = arguments[i];
      }
      return new AnonymousObservable(function(observer) {
        function handler(err) {
          if (err) {
            observer.onError(err);
            return ;
          }
          var len = arguments.length,
              results = [];
          for (var i = 1; i < len; i++) {
            results[i - 1] = arguments[i];
          }
          if (selector) {
            try {
              results = selector(results);
            } catch (e) {
              return observer.onError(e);
            }
            observer.onNext(results);
          } else {
            if (results.length <= 1) {
              observer.onNext.apply(observer, results);
            } else {
              observer.onNext(results);
            }
          }
          observer.onCompleted();
        }
        args.push(handler);
        func.apply(context, args);
      }).publishLast().refCount();
    };
  };
  function createListener(element, name, handler) {
    if (element.addEventListener) {
      element.addEventListener(name, handler, false);
      return disposableCreate(function() {
        element.removeEventListener(name, handler, false);
      });
    }
    throw new Error('No listener found');
  }
  function createEventListener(el, eventName, handler) {
    var disposables = new CompositeDisposable();
    if (Object.prototype.toString.call(el) === '[object NodeList]') {
      for (var i = 0,
          len = el.length; i < len; i++) {
        disposables.add(createEventListener(el.item(i), eventName, handler));
      }
    } else if (el) {
      disposables.add(createListener(el, eventName, handler));
    }
    return disposables;
  }
  Rx.config.useNativeEvents = false;
  Observable.fromEvent = function(element, eventName, selector) {
    if (element.addListener) {
      return fromEventPattern(function(h) {
        element.addListener(eventName, h);
      }, function(h) {
        element.removeListener(eventName, h);
      }, selector);
    }
    if (!Rx.config.useNativeEvents) {
      if (typeof element.on === 'function' && typeof element.off === 'function') {
        return fromEventPattern(function(h) {
          element.on(eventName, h);
        }, function(h) {
          element.off(eventName, h);
        }, selector);
      }
    }
    return new AnonymousObservable(function(observer) {
      return createEventListener(element, eventName, function handler(e) {
        var results = e;
        if (selector) {
          try {
            results = selector(arguments);
          } catch (err) {
            return observer.onError(err);
          }
        }
        observer.onNext(results);
      });
    }).publish().refCount();
  };
  var fromEventPattern = Observable.fromEventPattern = function(addHandler, removeHandler, selector) {
    return new AnonymousObservable(function(observer) {
      function innerHandler(e) {
        var result = e;
        if (selector) {
          try {
            result = selector(arguments);
          } catch (err) {
            return observer.onError(err);
          }
        }
        observer.onNext(result);
      }
      var returnValue = addHandler(innerHandler);
      return disposableCreate(function() {
        if (removeHandler) {
          removeHandler(innerHandler, returnValue);
        }
      });
    }).publish().refCount();
  };
  Observable.startAsync = function(functionAsync) {
    var promise;
    try {
      promise = functionAsync();
    } catch (e) {
      return observableThrow(e);
    }
    return observableFromPromise(promise);
  };
  var PausableObservable = (function(__super__) {
    inherits(PausableObservable, __super__);
    function subscribe(observer) {
      var conn = this.source.publish(),
          subscription = conn.subscribe(observer),
          connection = disposableEmpty;
      var pausable = this.pauser.distinctUntilChanged().subscribe(function(b) {
        if (b) {
          connection = conn.connect();
        } else {
          connection.dispose();
          connection = disposableEmpty;
        }
      });
      return new CompositeDisposable(subscription, connection, pausable);
    }
    function PausableObservable(source, pauser) {
      this.source = source;
      this.controller = new Subject();
      if (pauser && pauser.subscribe) {
        this.pauser = this.controller.merge(pauser);
      } else {
        this.pauser = this.controller;
      }
      __super__.call(this, subscribe, source);
    }
    PausableObservable.prototype.pause = function() {
      this.controller.onNext(false);
    };
    PausableObservable.prototype.resume = function() {
      this.controller.onNext(true);
    };
    return PausableObservable;
  }(Observable));
  observableProto.pausable = function(pauser) {
    return new PausableObservable(this, pauser);
  };
  function combineLatestSource(source, subject, resultSelector) {
    return new AnonymousObservable(function(o) {
      var hasValue = [false, false],
          hasValueAll = false,
          isDone = false,
          values = new Array(2),
          err;
      function next(x, i) {
        values[i] = x;
        var res;
        hasValue[i] = true;
        if (hasValueAll || (hasValueAll = hasValue.every(identity))) {
          if (err) {
            o.onError(err);
            return ;
          }
          try {
            res = resultSelector.apply(null, values);
          } catch (ex) {
            o.onError(ex);
            return ;
          }
          o.onNext(res);
        }
        if (isDone && values[1]) {
          o.onCompleted();
        }
      }
      return new CompositeDisposable(source.subscribe(function(x) {
        next(x, 0);
      }, function(e) {
        if (values[1]) {
          o.onError(e);
        } else {
          err = e;
        }
      }, function() {
        isDone = true;
        values[1] && o.onCompleted();
      }), subject.subscribe(function(x) {
        next(x, 1);
      }, function(e) {
        o.onError(e);
      }, function() {
        isDone = true;
        next(true, 1);
      }));
    }, source);
  }
  var PausableBufferedObservable = (function(__super__) {
    inherits(PausableBufferedObservable, __super__);
    function subscribe(o) {
      var q = [],
          previousShouldFire;
      var subscription = combineLatestSource(this.source, this.pauser.distinctUntilChanged().startWith(false), function(data, shouldFire) {
        return {
          data: data,
          shouldFire: shouldFire
        };
      }).subscribe(function(results) {
        if (previousShouldFire !== undefined && results.shouldFire != previousShouldFire) {
          previousShouldFire = results.shouldFire;
          if (results.shouldFire) {
            while (q.length > 0) {
              o.onNext(q.shift());
            }
          }
        } else {
          previousShouldFire = results.shouldFire;
          if (results.shouldFire) {
            o.onNext(results.data);
          } else {
            q.push(results.data);
          }
        }
      }, function(err) {
        while (q.length > 0) {
          o.onNext(q.shift());
        }
        o.onError(err);
      }, function() {
        while (q.length > 0) {
          o.onNext(q.shift());
        }
        o.onCompleted();
      });
      return subscription;
    }
    function PausableBufferedObservable(source, pauser) {
      this.source = source;
      this.controller = new Subject();
      if (pauser && pauser.subscribe) {
        this.pauser = this.controller.merge(pauser);
      } else {
        this.pauser = this.controller;
      }
      __super__.call(this, subscribe, source);
    }
    PausableBufferedObservable.prototype.pause = function() {
      this.controller.onNext(false);
    };
    PausableBufferedObservable.prototype.resume = function() {
      this.controller.onNext(true);
    };
    return PausableBufferedObservable;
  }(Observable));
  observableProto.pausableBuffered = function(subject) {
    return new PausableBufferedObservable(this, subject);
  };
  var ControlledObservable = (function(__super__) {
    inherits(ControlledObservable, __super__);
    function subscribe(observer) {
      return this.source.subscribe(observer);
    }
    function ControlledObservable(source, enableQueue) {
      __super__.call(this, subscribe, source);
      this.subject = new ControlledSubject(enableQueue);
      this.source = source.multicast(this.subject).refCount();
    }
    ControlledObservable.prototype.request = function(numberOfItems) {
      if (numberOfItems == null) {
        numberOfItems = -1;
      }
      return this.subject.request(numberOfItems);
    };
    return ControlledObservable;
  }(Observable));
  var ControlledSubject = (function(__super__) {
    function subscribe(observer) {
      return this.subject.subscribe(observer);
    }
    inherits(ControlledSubject, __super__);
    function ControlledSubject(enableQueue) {
      enableQueue == null && (enableQueue = true);
      __super__.call(this, subscribe);
      this.subject = new Subject();
      this.enableQueue = enableQueue;
      this.queue = enableQueue ? [] : null;
      this.requestedCount = 0;
      this.requestedDisposable = disposableEmpty;
      this.error = null;
      this.hasFailed = false;
      this.hasCompleted = false;
    }
    addProperties(ControlledSubject.prototype, Observer, {
      onCompleted: function() {
        this.hasCompleted = true;
        if (!this.enableQueue || this.queue.length === 0)
          this.subject.onCompleted();
        else
          this.queue.push(Rx.Notification.createOnCompleted());
      },
      onError: function(error) {
        this.hasFailed = true;
        this.error = error;
        if (!this.enableQueue || this.queue.length === 0)
          this.subject.onError(error);
        else
          this.queue.push(Rx.Notification.createOnError(error));
      },
      onNext: function(value) {
        var hasRequested = false;
        if (this.requestedCount === 0) {
          this.enableQueue && this.queue.push(Rx.Notification.createOnNext(value));
        } else {
          (this.requestedCount !== -1 && this.requestedCount-- === 0) && this.disposeCurrentRequest();
          hasRequested = true;
        }
        hasRequested && this.subject.onNext(value);
      },
      _processRequest: function(numberOfItems) {
        if (this.enableQueue) {
          while ((this.queue.length >= numberOfItems && numberOfItems > 0) || (this.queue.length > 0 && this.queue[0].kind !== 'N')) {
            var first = this.queue.shift();
            first.accept(this.subject);
            if (first.kind === 'N')
              numberOfItems--;
            else {
              this.disposeCurrentRequest();
              this.queue = [];
            }
          }
          return {
            numberOfItems: numberOfItems,
            returnValue: this.queue.length !== 0
          };
        }
        return {
          numberOfItems: numberOfItems,
          returnValue: false
        };
      },
      request: function(number) {
        this.disposeCurrentRequest();
        var self = this,
            r = this._processRequest(number);
        var number = r.numberOfItems;
        if (!r.returnValue) {
          this.requestedCount = number;
          this.requestedDisposable = disposableCreate(function() {
            self.requestedCount = 0;
          });
          return this.requestedDisposable;
        } else {
          return disposableEmpty;
        }
      },
      disposeCurrentRequest: function() {
        this.requestedDisposable.dispose();
        this.requestedDisposable = disposableEmpty;
      }
    });
    return ControlledSubject;
  }(Observable));
  observableProto.controlled = function(enableQueue) {
    if (enableQueue == null) {
      enableQueue = true;
    }
    return new ControlledObservable(this, enableQueue);
  };
  var StopAndWaitObservable = (function(__super__) {
    function subscribe(observer) {
      this.subscription = this.source.subscribe(new StopAndWaitObserver(observer, this, this.subscription));
      var self = this;
      timeoutScheduler.schedule(function() {
        self.source.request(1);
      });
      return this.subscription;
    }
    inherits(StopAndWaitObservable, __super__);
    function StopAndWaitObservable(source) {
      __super__.call(this, subscribe, source);
      this.source = source;
    }
    var StopAndWaitObserver = (function(__sub__) {
      inherits(StopAndWaitObserver, __sub__);
      function StopAndWaitObserver(observer, observable, cancel) {
        __sub__.call(this);
        this.observer = observer;
        this.observable = observable;
        this.cancel = cancel;
      }
      var stopAndWaitObserverProto = StopAndWaitObserver.prototype;
      stopAndWaitObserverProto.completed = function() {
        this.observer.onCompleted();
        this.dispose();
      };
      stopAndWaitObserverProto.error = function(error) {
        this.observer.onError(error);
        this.dispose();
      };
      stopAndWaitObserverProto.next = function(value) {
        this.observer.onNext(value);
        var self = this;
        timeoutScheduler.schedule(function() {
          self.observable.source.request(1);
        });
      };
      stopAndWaitObserverProto.dispose = function() {
        this.observer = null;
        if (this.cancel) {
          this.cancel.dispose();
          this.cancel = null;
        }
        __sub__.prototype.dispose.call(this);
      };
      return StopAndWaitObserver;
    }(AbstractObserver));
    return StopAndWaitObservable;
  }(Observable));
  ControlledObservable.prototype.stopAndWait = function() {
    return new StopAndWaitObservable(this);
  };
  var WindowedObservable = (function(__super__) {
    function subscribe(observer) {
      this.subscription = this.source.subscribe(new WindowedObserver(observer, this, this.subscription));
      var self = this;
      timeoutScheduler.schedule(function() {
        self.source.request(self.windowSize);
      });
      return this.subscription;
    }
    inherits(WindowedObservable, __super__);
    function WindowedObservable(source, windowSize) {
      __super__.call(this, subscribe, source);
      this.source = source;
      this.windowSize = windowSize;
    }
    var WindowedObserver = (function(__sub__) {
      inherits(WindowedObserver, __sub__);
      function WindowedObserver(observer, observable, cancel) {
        this.observer = observer;
        this.observable = observable;
        this.cancel = cancel;
        this.received = 0;
      }
      var windowedObserverPrototype = WindowedObserver.prototype;
      windowedObserverPrototype.completed = function() {
        this.observer.onCompleted();
        this.dispose();
      };
      windowedObserverPrototype.error = function(error) {
        this.observer.onError(error);
        this.dispose();
      };
      windowedObserverPrototype.next = function(value) {
        this.observer.onNext(value);
        this.received = ++this.received % this.observable.windowSize;
        if (this.received === 0) {
          var self = this;
          timeoutScheduler.schedule(function() {
            self.observable.source.request(self.observable.windowSize);
          });
        }
      };
      windowedObserverPrototype.dispose = function() {
        this.observer = null;
        if (this.cancel) {
          this.cancel.dispose();
          this.cancel = null;
        }
        __sub__.prototype.dispose.call(this);
      };
      return WindowedObserver;
    }(AbstractObserver));
    return WindowedObservable;
  }(Observable));
  ControlledObservable.prototype.windowed = function(windowSize) {
    return new WindowedObservable(this, windowSize);
  };
  observableProto.multicast = function(subjectOrSubjectSelector, selector) {
    var source = this;
    return typeof subjectOrSubjectSelector === 'function' ? new AnonymousObservable(function(observer) {
      var connectable = source.multicast(subjectOrSubjectSelector());
      return new CompositeDisposable(selector(connectable).subscribe(observer), connectable.connect());
    }, source) : new ConnectableObservable(source, subjectOrSubjectSelector);
  };
  observableProto.publish = function(selector) {
    return selector && isFunction(selector) ? this.multicast(function() {
      return new Subject();
    }, selector) : this.multicast(new Subject());
  };
  observableProto.share = function() {
    return this.publish().refCount();
  };
  observableProto.publishLast = function(selector) {
    return selector && isFunction(selector) ? this.multicast(function() {
      return new AsyncSubject();
    }, selector) : this.multicast(new AsyncSubject());
  };
  observableProto.publishValue = function(initialValueOrSelector, initialValue) {
    return arguments.length === 2 ? this.multicast(function() {
      return new BehaviorSubject(initialValue);
    }, initialValueOrSelector) : this.multicast(new BehaviorSubject(initialValueOrSelector));
  };
  observableProto.shareValue = function(initialValue) {
    return this.publishValue(initialValue).refCount();
  };
  observableProto.replay = function(selector, bufferSize, windowSize, scheduler) {
    return selector && isFunction(selector) ? this.multicast(function() {
      return new ReplaySubject(bufferSize, windowSize, scheduler);
    }, selector) : this.multicast(new ReplaySubject(bufferSize, windowSize, scheduler));
  };
  observableProto.shareReplay = function(bufferSize, windowSize, scheduler) {
    return this.replay(null, bufferSize, windowSize, scheduler).refCount();
  };
  var InnerSubscription = function(subject, observer) {
    this.subject = subject;
    this.observer = observer;
  };
  InnerSubscription.prototype.dispose = function() {
    if (!this.subject.isDisposed && this.observer !== null) {
      var idx = this.subject.observers.indexOf(this.observer);
      this.subject.observers.splice(idx, 1);
      this.observer = null;
    }
  };
  var BehaviorSubject = Rx.BehaviorSubject = (function(__super__) {
    function subscribe(observer) {
      checkDisposed(this);
      if (!this.isStopped) {
        this.observers.push(observer);
        observer.onNext(this.value);
        return new InnerSubscription(this, observer);
      }
      if (this.hasError) {
        observer.onError(this.error);
      } else {
        observer.onCompleted();
      }
      return disposableEmpty;
    }
    inherits(BehaviorSubject, __super__);
    function BehaviorSubject(value) {
      __super__.call(this, subscribe);
      this.value = value, this.observers = [], this.isDisposed = false, this.isStopped = false, this.hasError = false;
    }
    addProperties(BehaviorSubject.prototype, Observer, {
      getValue: function() {
        checkDisposed(this);
        if (this.hasError) {
          throw this.error;
        }
        return this.value;
      },
      hasObservers: function() {
        return this.observers.length > 0;
      },
      onCompleted: function() {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.isStopped = true;
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          os[i].onCompleted();
        }
        this.observers.length = 0;
      },
      onError: function(error) {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.isStopped = true;
        this.hasError = true;
        this.error = error;
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          os[i].onError(error);
        }
        this.observers.length = 0;
      },
      onNext: function(value) {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.value = value;
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          os[i].onNext(value);
        }
      },
      dispose: function() {
        this.isDisposed = true;
        this.observers = null;
        this.value = null;
        this.exception = null;
      }
    });
    return BehaviorSubject;
  }(Observable));
  var ReplaySubject = Rx.ReplaySubject = (function(__super__) {
    var maxSafeInteger = Math.pow(2, 53) - 1;
    function createRemovableDisposable(subject, observer) {
      return disposableCreate(function() {
        observer.dispose();
        !subject.isDisposed && subject.observers.splice(subject.observers.indexOf(observer), 1);
      });
    }
    function subscribe(observer) {
      var so = new ScheduledObserver(this.scheduler, observer),
          subscription = createRemovableDisposable(this, so);
      checkDisposed(this);
      this._trim(this.scheduler.now());
      this.observers.push(so);
      for (var i = 0,
          len = this.q.length; i < len; i++) {
        so.onNext(this.q[i].value);
      }
      if (this.hasError) {
        so.onError(this.error);
      } else if (this.isStopped) {
        so.onCompleted();
      }
      so.ensureActive();
      return subscription;
    }
    inherits(ReplaySubject, __super__);
    function ReplaySubject(bufferSize, windowSize, scheduler) {
      this.bufferSize = bufferSize == null ? maxSafeInteger : bufferSize;
      this.windowSize = windowSize == null ? maxSafeInteger : windowSize;
      this.scheduler = scheduler || currentThreadScheduler;
      this.q = [];
      this.observers = [];
      this.isStopped = false;
      this.isDisposed = false;
      this.hasError = false;
      this.error = null;
      __super__.call(this, subscribe);
    }
    addProperties(ReplaySubject.prototype, Observer.prototype, {
      hasObservers: function() {
        return this.observers.length > 0;
      },
      _trim: function(now) {
        while (this.q.length > this.bufferSize) {
          this.q.shift();
        }
        while (this.q.length > 0 && (now - this.q[0].interval) > this.windowSize) {
          this.q.shift();
        }
      },
      onNext: function(value) {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        var now = this.scheduler.now();
        this.q.push({
          interval: now,
          value: value
        });
        this._trim(now);
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          var observer = os[i];
          observer.onNext(value);
          observer.ensureActive();
        }
      },
      onError: function(error) {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.isStopped = true;
        this.error = error;
        this.hasError = true;
        var now = this.scheduler.now();
        this._trim(now);
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          var observer = os[i];
          observer.onError(error);
          observer.ensureActive();
        }
        this.observers.length = 0;
      },
      onCompleted: function() {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.isStopped = true;
        var now = this.scheduler.now();
        this._trim(now);
        for (var i = 0,
            os = cloneArray(this.observers),
            len = os.length; i < len; i++) {
          var observer = os[i];
          observer.onCompleted();
          observer.ensureActive();
        }
        this.observers.length = 0;
      },
      dispose: function() {
        this.isDisposed = true;
        this.observers = null;
      }
    });
    return ReplaySubject;
  }(Observable));
  var ConnectableObservable = Rx.ConnectableObservable = (function(__super__) {
    inherits(ConnectableObservable, __super__);
    function ConnectableObservable(source, subject) {
      var hasSubscription = false,
          subscription,
          sourceObservable = source.asObservable();
      this.connect = function() {
        if (!hasSubscription) {
          hasSubscription = true;
          subscription = new CompositeDisposable(sourceObservable.subscribe(subject), disposableCreate(function() {
            hasSubscription = false;
          }));
        }
        return subscription;
      };
      __super__.call(this, function(o) {
        return subject.subscribe(o);
      });
    }
    ConnectableObservable.prototype.refCount = function() {
      var connectableSubscription,
          count = 0,
          source = this;
      return new AnonymousObservable(function(observer) {
        var shouldConnect = ++count === 1,
            subscription = source.subscribe(observer);
        shouldConnect && (connectableSubscription = source.connect());
        return function() {
          subscription.dispose();
          --count === 0 && connectableSubscription.dispose();
        };
      });
    };
    return ConnectableObservable;
  }(Observable));
  var Dictionary = (function() {
    var primes = [1, 3, 7, 13, 31, 61, 127, 251, 509, 1021, 2039, 4093, 8191, 16381, 32749, 65521, 131071, 262139, 524287, 1048573, 2097143, 4194301, 8388593, 16777213, 33554393, 67108859, 134217689, 268435399, 536870909, 1073741789, 2147483647],
        noSuchkey = "no such key",
        duplicatekey = "duplicate key";
    function isPrime(candidate) {
      if ((candidate & 1) === 0) {
        return candidate === 2;
      }
      var num1 = Math.sqrt(candidate),
          num2 = 3;
      while (num2 <= num1) {
        if (candidate % num2 === 0) {
          return false;
        }
        num2 += 2;
      }
      return true;
    }
    function getPrime(min) {
      var index,
          num,
          candidate;
      for (index = 0; index < primes.length; ++index) {
        num = primes[index];
        if (num >= min) {
          return num;
        }
      }
      candidate = min | 1;
      while (candidate < primes[primes.length - 1]) {
        if (isPrime(candidate)) {
          return candidate;
        }
        candidate += 2;
      }
      return min;
    }
    function stringHashFn(str) {
      var hash = 757602046;
      if (!str.length) {
        return hash;
      }
      for (var i = 0,
          len = str.length; i < len; i++) {
        var character = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + character;
        hash = hash & hash;
      }
      return hash;
    }
    function numberHashFn(key) {
      var c2 = 0x27d4eb2d;
      key = (key ^ 61) ^ (key >>> 16);
      key = key + (key << 3);
      key = key ^ (key >>> 4);
      key = key * c2;
      key = key ^ (key >>> 15);
      return key;
    }
    var getHashCode = (function() {
      var uniqueIdCounter = 0;
      return function(obj) {
        if (obj == null) {
          throw new Error(noSuchkey);
        }
        if (typeof obj === 'string') {
          return stringHashFn(obj);
        }
        if (typeof obj === 'number') {
          return numberHashFn(obj);
        }
        if (typeof obj === 'boolean') {
          return obj === true ? 1 : 0;
        }
        if (obj instanceof Date) {
          return numberHashFn(obj.valueOf());
        }
        if (obj instanceof RegExp) {
          return stringHashFn(obj.toString());
        }
        if (typeof obj.valueOf === 'function') {
          var valueOf = obj.valueOf();
          if (typeof valueOf === 'number') {
            return numberHashFn(valueOf);
          }
          if (typeof valueOf === 'string') {
            return stringHashFn(valueOf);
          }
        }
        if (obj.hashCode) {
          return obj.hashCode();
        }
        var id = 17 * uniqueIdCounter++;
        obj.hashCode = function() {
          return id;
        };
        return id;
      };
    }());
    function newEntry() {
      return {
        key: null,
        value: null,
        next: 0,
        hashCode: 0
      };
    }
    function Dictionary(capacity, comparer) {
      if (capacity < 0) {
        throw new ArgumentOutOfRangeError();
      }
      if (capacity > 0) {
        this._initialize(capacity);
      }
      this.comparer = comparer || defaultComparer;
      this.freeCount = 0;
      this.size = 0;
      this.freeList = -1;
    }
    var dictionaryProto = Dictionary.prototype;
    dictionaryProto._initialize = function(capacity) {
      var prime = getPrime(capacity),
          i;
      this.buckets = new Array(prime);
      this.entries = new Array(prime);
      for (i = 0; i < prime; i++) {
        this.buckets[i] = -1;
        this.entries[i] = newEntry();
      }
      this.freeList = -1;
    };
    dictionaryProto.add = function(key, value) {
      this._insert(key, value, true);
    };
    dictionaryProto._insert = function(key, value, add) {
      if (!this.buckets) {
        this._initialize(0);
      }
      var index3,
          num = getHashCode(key) & 2147483647,
          index1 = num % this.buckets.length;
      for (var index2 = this.buckets[index1]; index2 >= 0; index2 = this.entries[index2].next) {
        if (this.entries[index2].hashCode === num && this.comparer(this.entries[index2].key, key)) {
          if (add) {
            throw new Error(duplicatekey);
          }
          this.entries[index2].value = value;
          return ;
        }
      }
      if (this.freeCount > 0) {
        index3 = this.freeList;
        this.freeList = this.entries[index3].next;
        --this.freeCount;
      } else {
        if (this.size === this.entries.length) {
          this._resize();
          index1 = num % this.buckets.length;
        }
        index3 = this.size;
        ++this.size;
      }
      this.entries[index3].hashCode = num;
      this.entries[index3].next = this.buckets[index1];
      this.entries[index3].key = key;
      this.entries[index3].value = value;
      this.buckets[index1] = index3;
    };
    dictionaryProto._resize = function() {
      var prime = getPrime(this.size * 2),
          numArray = new Array(prime);
      for (index = 0; index < numArray.length; ++index) {
        numArray[index] = -1;
      }
      var entryArray = new Array(prime);
      for (index = 0; index < this.size; ++index) {
        entryArray[index] = this.entries[index];
      }
      for (var index = this.size; index < prime; ++index) {
        entryArray[index] = newEntry();
      }
      for (var index1 = 0; index1 < this.size; ++index1) {
        var index2 = entryArray[index1].hashCode % prime;
        entryArray[index1].next = numArray[index2];
        numArray[index2] = index1;
      }
      this.buckets = numArray;
      this.entries = entryArray;
    };
    dictionaryProto.remove = function(key) {
      if (this.buckets) {
        var num = getHashCode(key) & 2147483647,
            index1 = num % this.buckets.length,
            index2 = -1;
        for (var index3 = this.buckets[index1]; index3 >= 0; index3 = this.entries[index3].next) {
          if (this.entries[index3].hashCode === num && this.comparer(this.entries[index3].key, key)) {
            if (index2 < 0) {
              this.buckets[index1] = this.entries[index3].next;
            } else {
              this.entries[index2].next = this.entries[index3].next;
            }
            this.entries[index3].hashCode = -1;
            this.entries[index3].next = this.freeList;
            this.entries[index3].key = null;
            this.entries[index3].value = null;
            this.freeList = index3;
            ++this.freeCount;
            return true;
          } else {
            index2 = index3;
          }
        }
      }
      return false;
    };
    dictionaryProto.clear = function() {
      var index,
          len;
      if (this.size <= 0) {
        return ;
      }
      for (index = 0, len = this.buckets.length; index < len; ++index) {
        this.buckets[index] = -1;
      }
      for (index = 0; index < this.size; ++index) {
        this.entries[index] = newEntry();
      }
      this.freeList = -1;
      this.size = 0;
    };
    dictionaryProto._findEntry = function(key) {
      if (this.buckets) {
        var num = getHashCode(key) & 2147483647;
        for (var index = this.buckets[num % this.buckets.length]; index >= 0; index = this.entries[index].next) {
          if (this.entries[index].hashCode === num && this.comparer(this.entries[index].key, key)) {
            return index;
          }
        }
      }
      return -1;
    };
    dictionaryProto.count = function() {
      return this.size - this.freeCount;
    };
    dictionaryProto.tryGetValue = function(key) {
      var entry = this._findEntry(key);
      return entry >= 0 ? this.entries[entry].value : undefined;
    };
    dictionaryProto.getValues = function() {
      var index = 0,
          results = [];
      if (this.entries) {
        for (var index1 = 0; index1 < this.size; index1++) {
          if (this.entries[index1].hashCode >= 0) {
            results[index++] = this.entries[index1].value;
          }
        }
      }
      return results;
    };
    dictionaryProto.get = function(key) {
      var entry = this._findEntry(key);
      if (entry >= 0) {
        return this.entries[entry].value;
      }
      throw new Error(noSuchkey);
    };
    dictionaryProto.set = function(key, value) {
      this._insert(key, value, false);
    };
    dictionaryProto.containskey = function(key) {
      return this._findEntry(key) >= 0;
    };
    return Dictionary;
  }());
  observableProto.join = function(right, leftDurationSelector, rightDurationSelector, resultSelector) {
    var left = this;
    return new AnonymousObservable(function(observer) {
      var group = new CompositeDisposable();
      var leftDone = false,
          rightDone = false;
      var leftId = 0,
          rightId = 0;
      var leftMap = new Dictionary(),
          rightMap = new Dictionary();
      group.add(left.subscribe(function(value) {
        var id = leftId++;
        var md = new SingleAssignmentDisposable();
        leftMap.add(id, value);
        group.add(md);
        var expire = function() {
          leftMap.remove(id) && leftMap.count() === 0 && leftDone && observer.onCompleted();
          group.remove(md);
        };
        var duration;
        try {
          duration = leftDurationSelector(value);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        md.setDisposable(duration.take(1).subscribe(noop, observer.onError.bind(observer), expire));
        rightMap.getValues().forEach(function(v) {
          var result;
          try {
            result = resultSelector(value, v);
          } catch (exn) {
            observer.onError(exn);
            return ;
          }
          observer.onNext(result);
        });
      }, observer.onError.bind(observer), function() {
        leftDone = true;
        (rightDone || leftMap.count() === 0) && observer.onCompleted();
      }));
      group.add(right.subscribe(function(value) {
        var id = rightId++;
        var md = new SingleAssignmentDisposable();
        rightMap.add(id, value);
        group.add(md);
        var expire = function() {
          rightMap.remove(id) && rightMap.count() === 0 && rightDone && observer.onCompleted();
          group.remove(md);
        };
        var duration;
        try {
          duration = rightDurationSelector(value);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        md.setDisposable(duration.take(1).subscribe(noop, observer.onError.bind(observer), expire));
        leftMap.getValues().forEach(function(v) {
          var result;
          try {
            result = resultSelector(v, value);
          } catch (exn) {
            observer.onError(exn);
            return ;
          }
          observer.onNext(result);
        });
      }, observer.onError.bind(observer), function() {
        rightDone = true;
        (leftDone || rightMap.count() === 0) && observer.onCompleted();
      }));
      return group;
    }, left);
  };
  observableProto.groupJoin = function(right, leftDurationSelector, rightDurationSelector, resultSelector) {
    var left = this;
    return new AnonymousObservable(function(observer) {
      var group = new CompositeDisposable();
      var r = new RefCountDisposable(group);
      var leftMap = new Dictionary(),
          rightMap = new Dictionary();
      var leftId = 0,
          rightId = 0;
      function handleError(e) {
        return function(v) {
          v.onError(e);
        };
      }
      ;
      group.add(left.subscribe(function(value) {
        var s = new Subject();
        var id = leftId++;
        leftMap.add(id, s);
        var result;
        try {
          result = resultSelector(value, addRef(s, r));
        } catch (e) {
          leftMap.getValues().forEach(handleError(e));
          observer.onError(e);
          return ;
        }
        observer.onNext(result);
        rightMap.getValues().forEach(function(v) {
          s.onNext(v);
        });
        var md = new SingleAssignmentDisposable();
        group.add(md);
        var expire = function() {
          leftMap.remove(id) && s.onCompleted();
          group.remove(md);
        };
        var duration;
        try {
          duration = leftDurationSelector(value);
        } catch (e) {
          leftMap.getValues().forEach(handleError(e));
          observer.onError(e);
          return ;
        }
        md.setDisposable(duration.take(1).subscribe(noop, function(e) {
          leftMap.getValues().forEach(handleError(e));
          observer.onError(e);
        }, expire));
      }, function(e) {
        leftMap.getValues().forEach(handleError(e));
        observer.onError(e);
      }, observer.onCompleted.bind(observer)));
      group.add(right.subscribe(function(value) {
        var id = rightId++;
        rightMap.add(id, value);
        var md = new SingleAssignmentDisposable();
        group.add(md);
        var expire = function() {
          rightMap.remove(id);
          group.remove(md);
        };
        var duration;
        try {
          duration = rightDurationSelector(value);
        } catch (e) {
          leftMap.getValues().forEach(handleError(e));
          observer.onError(e);
          return ;
        }
        md.setDisposable(duration.take(1).subscribe(noop, function(e) {
          leftMap.getValues().forEach(handleError(e));
          observer.onError(e);
        }, expire));
        leftMap.getValues().forEach(function(v) {
          v.onNext(value);
        });
      }, function(e) {
        leftMap.getValues().forEach(handleError(e));
        observer.onError(e);
      }));
      return r;
    }, left);
  };
  observableProto.buffer = function(bufferOpeningsOrClosingSelector, bufferClosingSelector) {
    return this.window.apply(this, arguments).selectMany(function(x) {
      return x.toArray();
    });
  };
  observableProto.window = function(windowOpeningsOrClosingSelector, windowClosingSelector) {
    if (arguments.length === 1 && typeof arguments[0] !== 'function') {
      return observableWindowWithBoundaries.call(this, windowOpeningsOrClosingSelector);
    }
    return typeof windowOpeningsOrClosingSelector === 'function' ? observableWindowWithClosingSelector.call(this, windowOpeningsOrClosingSelector) : observableWindowWithOpenings.call(this, windowOpeningsOrClosingSelector, windowClosingSelector);
  };
  function observableWindowWithOpenings(windowOpenings, windowClosingSelector) {
    return windowOpenings.groupJoin(this, windowClosingSelector, observableEmpty, function(_, win) {
      return win;
    });
  }
  function observableWindowWithBoundaries(windowBoundaries) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var win = new Subject(),
          d = new CompositeDisposable(),
          r = new RefCountDisposable(d);
      observer.onNext(addRef(win, r));
      d.add(source.subscribe(function(x) {
        win.onNext(x);
      }, function(err) {
        win.onError(err);
        observer.onError(err);
      }, function() {
        win.onCompleted();
        observer.onCompleted();
      }));
      isPromise(windowBoundaries) && (windowBoundaries = observableFromPromise(windowBoundaries));
      d.add(windowBoundaries.subscribe(function(w) {
        win.onCompleted();
        win = new Subject();
        observer.onNext(addRef(win, r));
      }, function(err) {
        win.onError(err);
        observer.onError(err);
      }, function() {
        win.onCompleted();
        observer.onCompleted();
      }));
      return r;
    }, source);
  }
  function observableWindowWithClosingSelector(windowClosingSelector) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var m = new SerialDisposable(),
          d = new CompositeDisposable(m),
          r = new RefCountDisposable(d),
          win = new Subject();
      observer.onNext(addRef(win, r));
      d.add(source.subscribe(function(x) {
        win.onNext(x);
      }, function(err) {
        win.onError(err);
        observer.onError(err);
      }, function() {
        win.onCompleted();
        observer.onCompleted();
      }));
      function createWindowClose() {
        var windowClose;
        try {
          windowClose = windowClosingSelector();
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(windowClose) && (windowClose = observableFromPromise(windowClose));
        var m1 = new SingleAssignmentDisposable();
        m.setDisposable(m1);
        m1.setDisposable(windowClose.take(1).subscribe(noop, function(err) {
          win.onError(err);
          observer.onError(err);
        }, function() {
          win.onCompleted();
          win = new Subject();
          observer.onNext(addRef(win, r));
          createWindowClose();
        }));
      }
      createWindowClose();
      return r;
    }, source);
  }
  observableProto.pairwise = function() {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var previous,
          hasPrevious = false;
      return source.subscribe(function(x) {
        if (hasPrevious) {
          observer.onNext([previous, x]);
        } else {
          hasPrevious = true;
        }
        previous = x;
      }, observer.onError.bind(observer), observer.onCompleted.bind(observer));
    }, source);
  };
  observableProto.partition = function(predicate, thisArg) {
    return [this.filter(predicate, thisArg), this.filter(function(x, i, o) {
      return !predicate.call(thisArg, x, i, o);
    })];
  };
  function enumerableWhile(condition, source) {
    return new Enumerable(function() {
      return new Enumerator(function() {
        return condition() ? {
          done: false,
          value: source
        } : {
          done: true,
          value: undefined
        };
      });
    });
  }
  observableProto.letBind = observableProto['let'] = function(func) {
    return func(this);
  };
  Observable['if'] = Observable.ifThen = function(condition, thenSource, elseSourceOrScheduler) {
    return observableDefer(function() {
      elseSourceOrScheduler || (elseSourceOrScheduler = observableEmpty());
      isPromise(thenSource) && (thenSource = observableFromPromise(thenSource));
      isPromise(elseSourceOrScheduler) && (elseSourceOrScheduler = observableFromPromise(elseSourceOrScheduler));
      typeof elseSourceOrScheduler.now === 'function' && (elseSourceOrScheduler = observableEmpty(elseSourceOrScheduler));
      return condition() ? thenSource : elseSourceOrScheduler;
    });
  };
  Observable['for'] = Observable.forIn = function(sources, resultSelector, thisArg) {
    return enumerableOf(sources, resultSelector, thisArg).concat();
  };
  var observableWhileDo = Observable['while'] = Observable.whileDo = function(condition, source) {
    isPromise(source) && (source = observableFromPromise(source));
    return enumerableWhile(condition, source).concat();
  };
  observableProto.doWhile = function(condition) {
    return observableConcat([this, observableWhileDo(condition, this)]);
  };
  Observable['case'] = Observable.switchCase = function(selector, sources, defaultSourceOrScheduler) {
    return observableDefer(function() {
      isPromise(defaultSourceOrScheduler) && (defaultSourceOrScheduler = observableFromPromise(defaultSourceOrScheduler));
      defaultSourceOrScheduler || (defaultSourceOrScheduler = observableEmpty());
      typeof defaultSourceOrScheduler.now === 'function' && (defaultSourceOrScheduler = observableEmpty(defaultSourceOrScheduler));
      var result = sources[selector()];
      isPromise(result) && (result = observableFromPromise(result));
      return result || defaultSourceOrScheduler;
    });
  };
  observableProto.expand = function(selector, scheduler) {
    isScheduler(scheduler) || (scheduler = immediateScheduler);
    var source = this;
    return new AnonymousObservable(function(observer) {
      var q = [],
          m = new SerialDisposable(),
          d = new CompositeDisposable(m),
          activeCount = 0,
          isAcquired = false;
      var ensureActive = function() {
        var isOwner = false;
        if (q.length > 0) {
          isOwner = !isAcquired;
          isAcquired = true;
        }
        if (isOwner) {
          m.setDisposable(scheduler.scheduleRecursive(function(self) {
            var work;
            if (q.length > 0) {
              work = q.shift();
            } else {
              isAcquired = false;
              return ;
            }
            var m1 = new SingleAssignmentDisposable();
            d.add(m1);
            m1.setDisposable(work.subscribe(function(x) {
              observer.onNext(x);
              var result = null;
              try {
                result = selector(x);
              } catch (e) {
                observer.onError(e);
              }
              q.push(result);
              activeCount++;
              ensureActive();
            }, observer.onError.bind(observer), function() {
              d.remove(m1);
              activeCount--;
              if (activeCount === 0) {
                observer.onCompleted();
              }
            }));
            self();
          }));
        }
      };
      q.push(source);
      activeCount++;
      ensureActive();
      return d;
    }, this);
  };
  Observable.forkJoin = function() {
    var allSources = [];
    if (Array.isArray(arguments[0])) {
      allSources = arguments[0];
    } else {
      for (var i = 0,
          len = arguments.length; i < len; i++) {
        allSources.push(arguments[i]);
      }
    }
    return new AnonymousObservable(function(subscriber) {
      var count = allSources.length;
      if (count === 0) {
        subscriber.onCompleted();
        return disposableEmpty;
      }
      var group = new CompositeDisposable(),
          finished = false,
          hasResults = new Array(count),
          hasCompleted = new Array(count),
          results = new Array(count);
      for (var idx = 0; idx < count; idx++) {
        (function(i) {
          var source = allSources[i];
          isPromise(source) && (source = observableFromPromise(source));
          group.add(source.subscribe(function(value) {
            if (!finished) {
              hasResults[i] = true;
              results[i] = value;
            }
          }, function(e) {
            finished = true;
            subscriber.onError(e);
            group.dispose();
          }, function() {
            if (!finished) {
              if (!hasResults[i]) {
                subscriber.onCompleted();
                return ;
              }
              hasCompleted[i] = true;
              for (var ix = 0; ix < count; ix++) {
                if (!hasCompleted[ix]) {
                  return ;
                }
              }
              finished = true;
              subscriber.onNext(results);
              subscriber.onCompleted();
            }
          }));
        })(idx);
      }
      return group;
    });
  };
  observableProto.forkJoin = function(second, resultSelector) {
    var first = this;
    return new AnonymousObservable(function(observer) {
      var leftStopped = false,
          rightStopped = false,
          hasLeft = false,
          hasRight = false,
          lastLeft,
          lastRight,
          leftSubscription = new SingleAssignmentDisposable(),
          rightSubscription = new SingleAssignmentDisposable();
      isPromise(second) && (second = observableFromPromise(second));
      leftSubscription.setDisposable(first.subscribe(function(left) {
        hasLeft = true;
        lastLeft = left;
      }, function(err) {
        rightSubscription.dispose();
        observer.onError(err);
      }, function() {
        leftStopped = true;
        if (rightStopped) {
          if (!hasLeft) {
            observer.onCompleted();
          } else if (!hasRight) {
            observer.onCompleted();
          } else {
            var result;
            try {
              result = resultSelector(lastLeft, lastRight);
            } catch (e) {
              observer.onError(e);
              return ;
            }
            observer.onNext(result);
            observer.onCompleted();
          }
        }
      }));
      rightSubscription.setDisposable(second.subscribe(function(right) {
        hasRight = true;
        lastRight = right;
      }, function(err) {
        leftSubscription.dispose();
        observer.onError(err);
      }, function() {
        rightStopped = true;
        if (leftStopped) {
          if (!hasLeft) {
            observer.onCompleted();
          } else if (!hasRight) {
            observer.onCompleted();
          } else {
            var result;
            try {
              result = resultSelector(lastLeft, lastRight);
            } catch (e) {
              observer.onError(e);
              return ;
            }
            observer.onNext(result);
            observer.onCompleted();
          }
        }
      }));
      return new CompositeDisposable(leftSubscription, rightSubscription);
    }, first);
  };
  observableProto.manySelect = function(selector, scheduler) {
    isScheduler(scheduler) || (scheduler = immediateScheduler);
    var source = this;
    return observableDefer(function() {
      var chain;
      return source.map(function(x) {
        var curr = new ChainObservable(x);
        chain && chain.onNext(x);
        chain = curr;
        return curr;
      }).tap(noop, function(e) {
        chain && chain.onError(e);
      }, function() {
        chain && chain.onCompleted();
      }).observeOn(scheduler).map(selector);
    }, source);
  };
  var ChainObservable = (function(__super__) {
    function subscribe(observer) {
      var self = this,
          g = new CompositeDisposable();
      g.add(currentThreadScheduler.schedule(function() {
        observer.onNext(self.head);
        g.add(self.tail.mergeAll().subscribe(observer));
      }));
      return g;
    }
    inherits(ChainObservable, __super__);
    function ChainObservable(head) {
      __super__.call(this, subscribe);
      this.head = head;
      this.tail = new AsyncSubject();
    }
    addProperties(ChainObservable.prototype, Observer, {
      onCompleted: function() {
        this.onNext(Observable.empty());
      },
      onError: function(e) {
        this.onNext(Observable.throwError(e));
      },
      onNext: function(v) {
        this.tail.onNext(v);
        this.tail.onCompleted();
      }
    });
    return ChainObservable;
  }(Observable));
  var Map = root.Map || (function() {
    function Map() {
      this._keys = [];
      this._values = [];
    }
    Map.prototype.get = function(key) {
      var i = this._keys.indexOf(key);
      return i !== -1 ? this._values[i] : undefined;
    };
    Map.prototype.set = function(key, value) {
      var i = this._keys.indexOf(key);
      i !== -1 && (this._values[i] = value);
      this._values[this._keys.push(key) - 1] = value;
    };
    Map.prototype.forEach = function(callback, thisArg) {
      for (var i = 0,
          len = this._keys.length; i < len; i++) {
        callback.call(thisArg, this._values[i], this._keys[i]);
      }
    };
    return Map;
  }());
  function Pattern(patterns) {
    this.patterns = patterns;
  }
  Pattern.prototype.and = function(other) {
    return new Pattern(this.patterns.concat(other));
  };
  Pattern.prototype.thenDo = function(selector) {
    return new Plan(this, selector);
  };
  function Plan(expression, selector) {
    this.expression = expression;
    this.selector = selector;
  }
  Plan.prototype.activate = function(externalSubscriptions, observer, deactivate) {
    var self = this;
    var joinObservers = [];
    for (var i = 0,
        len = this.expression.patterns.length; i < len; i++) {
      joinObservers.push(planCreateObserver(externalSubscriptions, this.expression.patterns[i], observer.onError.bind(observer)));
    }
    var activePlan = new ActivePlan(joinObservers, function() {
      var result;
      try {
        result = self.selector.apply(self, arguments);
      } catch (e) {
        observer.onError(e);
        return ;
      }
      observer.onNext(result);
    }, function() {
      for (var j = 0,
          jlen = joinObservers.length; j < jlen; j++) {
        joinObservers[j].removeActivePlan(activePlan);
      }
      deactivate(activePlan);
    });
    for (i = 0, len = joinObservers.length; i < len; i++) {
      joinObservers[i].addActivePlan(activePlan);
    }
    return activePlan;
  };
  function planCreateObserver(externalSubscriptions, observable, onError) {
    var entry = externalSubscriptions.get(observable);
    if (!entry) {
      var observer = new JoinObserver(observable, onError);
      externalSubscriptions.set(observable, observer);
      return observer;
    }
    return entry;
  }
  function ActivePlan(joinObserverArray, onNext, onCompleted) {
    this.joinObserverArray = joinObserverArray;
    this.onNext = onNext;
    this.onCompleted = onCompleted;
    this.joinObservers = new Map();
    for (var i = 0,
        len = this.joinObserverArray.length; i < len; i++) {
      var joinObserver = this.joinObserverArray[i];
      this.joinObservers.set(joinObserver, joinObserver);
    }
  }
  ActivePlan.prototype.dequeue = function() {
    this.joinObservers.forEach(function(v) {
      v.queue.shift();
    });
  };
  ActivePlan.prototype.match = function() {
    var i,
        len,
        hasValues = true;
    for (i = 0, len = this.joinObserverArray.length; i < len; i++) {
      if (this.joinObserverArray[i].queue.length === 0) {
        hasValues = false;
        break;
      }
    }
    if (hasValues) {
      var firstValues = [],
          isCompleted = false;
      for (i = 0, len = this.joinObserverArray.length; i < len; i++) {
        firstValues.push(this.joinObserverArray[i].queue[0]);
        this.joinObserverArray[i].queue[0].kind === 'C' && (isCompleted = true);
      }
      if (isCompleted) {
        this.onCompleted();
      } else {
        this.dequeue();
        var values = [];
        for (i = 0, len = firstValues.length; i < firstValues.length; i++) {
          values.push(firstValues[i].value);
        }
        this.onNext.apply(this, values);
      }
    }
  };
  var JoinObserver = (function(__super__) {
    inherits(JoinObserver, __super__);
    function JoinObserver(source, onError) {
      __super__.call(this);
      this.source = source;
      this.onError = onError;
      this.queue = [];
      this.activePlans = [];
      this.subscription = new SingleAssignmentDisposable();
      this.isDisposed = false;
    }
    var JoinObserverPrototype = JoinObserver.prototype;
    JoinObserverPrototype.next = function(notification) {
      if (!this.isDisposed) {
        if (notification.kind === 'E') {
          return this.onError(notification.exception);
        }
        this.queue.push(notification);
        var activePlans = this.activePlans.slice(0);
        for (var i = 0,
            len = activePlans.length; i < len; i++) {
          activePlans[i].match();
        }
      }
    };
    JoinObserverPrototype.error = noop;
    JoinObserverPrototype.completed = noop;
    JoinObserverPrototype.addActivePlan = function(activePlan) {
      this.activePlans.push(activePlan);
    };
    JoinObserverPrototype.subscribe = function() {
      this.subscription.setDisposable(this.source.materialize().subscribe(this));
    };
    JoinObserverPrototype.removeActivePlan = function(activePlan) {
      this.activePlans.splice(this.activePlans.indexOf(activePlan), 1);
      this.activePlans.length === 0 && this.dispose();
    };
    JoinObserverPrototype.dispose = function() {
      __super__.prototype.dispose.call(this);
      if (!this.isDisposed) {
        this.isDisposed = true;
        this.subscription.dispose();
      }
    };
    return JoinObserver;
  }(AbstractObserver));
  observableProto.and = function(right) {
    return new Pattern([this, right]);
  };
  observableProto.thenDo = function(selector) {
    return new Pattern([this]).thenDo(selector);
  };
  Observable.when = function() {
    var len = arguments.length,
        plans;
    if (Array.isArray(arguments[0])) {
      plans = arguments[0];
    } else {
      plans = new Array(len);
      for (var i = 0; i < len; i++) {
        plans[i] = arguments[i];
      }
    }
    return new AnonymousObservable(function(o) {
      var activePlans = [],
          externalSubscriptions = new Map();
      var outObserver = observerCreate(function(x) {
        o.onNext(x);
      }, function(err) {
        externalSubscriptions.forEach(function(v) {
          v.onError(err);
        });
        o.onError(err);
      }, function(x) {
        o.onCompleted();
      });
      try {
        for (var i = 0,
            len = plans.length; i < len; i++) {
          activePlans.push(plans[i].activate(externalSubscriptions, outObserver, function(activePlan) {
            var idx = activePlans.indexOf(activePlan);
            activePlans.splice(idx, 1);
            activePlans.length === 0 && o.onCompleted();
          }));
        }
      } catch (e) {
        observableThrow(e).subscribe(o);
      }
      var group = new CompositeDisposable();
      externalSubscriptions.forEach(function(joinObserver) {
        joinObserver.subscribe();
        group.add(joinObserver);
      });
      return group;
    });
  };
  function observableTimerDate(dueTime, scheduler) {
    return new AnonymousObservable(function(observer) {
      return scheduler.scheduleWithAbsolute(dueTime, function() {
        observer.onNext(0);
        observer.onCompleted();
      });
    });
  }
  function observableTimerDateAndPeriod(dueTime, period, scheduler) {
    return new AnonymousObservable(function(observer) {
      var d = dueTime,
          p = normalizeTime(period);
      return scheduler.scheduleRecursiveWithAbsoluteAndState(0, d, function(count, self) {
        if (p > 0) {
          var now = scheduler.now();
          d = d + p;
          d <= now && (d = now + p);
        }
        observer.onNext(count);
        self(count + 1, d);
      });
    });
  }
  function observableTimerTimeSpan(dueTime, scheduler) {
    return new AnonymousObservable(function(observer) {
      return scheduler.scheduleWithRelative(normalizeTime(dueTime), function() {
        observer.onNext(0);
        observer.onCompleted();
      });
    });
  }
  function observableTimerTimeSpanAndPeriod(dueTime, period, scheduler) {
    return dueTime === period ? new AnonymousObservable(function(observer) {
      return scheduler.schedulePeriodicWithState(0, period, function(count) {
        observer.onNext(count);
        return count + 1;
      });
    }) : observableDefer(function() {
      return observableTimerDateAndPeriod(scheduler.now() + dueTime, period, scheduler);
    });
  }
  var observableinterval = Observable.interval = function(period, scheduler) {
    return observableTimerTimeSpanAndPeriod(period, period, isScheduler(scheduler) ? scheduler : timeoutScheduler);
  };
  var observableTimer = Observable.timer = function(dueTime, periodOrScheduler, scheduler) {
    var period;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    if (periodOrScheduler !== undefined && typeof periodOrScheduler === 'number') {
      period = periodOrScheduler;
    } else if (isScheduler(periodOrScheduler)) {
      scheduler = periodOrScheduler;
    }
    if (dueTime instanceof Date && period === undefined) {
      return observableTimerDate(dueTime.getTime(), scheduler);
    }
    if (dueTime instanceof Date && period !== undefined) {
      period = periodOrScheduler;
      return observableTimerDateAndPeriod(dueTime.getTime(), period, scheduler);
    }
    return period === undefined ? observableTimerTimeSpan(dueTime, scheduler) : observableTimerTimeSpanAndPeriod(dueTime, period, scheduler);
  };
  function observableDelayTimeSpan(source, dueTime, scheduler) {
    return new AnonymousObservable(function(observer) {
      var active = false,
          cancelable = new SerialDisposable(),
          exception = null,
          q = [],
          running = false,
          subscription;
      subscription = source.materialize().timestamp(scheduler).subscribe(function(notification) {
        var d,
            shouldRun;
        if (notification.value.kind === 'E') {
          q = [];
          q.push(notification);
          exception = notification.value.exception;
          shouldRun = !running;
        } else {
          q.push({
            value: notification.value,
            timestamp: notification.timestamp + dueTime
          });
          shouldRun = !active;
          active = true;
        }
        if (shouldRun) {
          if (exception !== null) {
            observer.onError(exception);
          } else {
            d = new SingleAssignmentDisposable();
            cancelable.setDisposable(d);
            d.setDisposable(scheduler.scheduleRecursiveWithRelative(dueTime, function(self) {
              var e,
                  recurseDueTime,
                  result,
                  shouldRecurse;
              if (exception !== null) {
                return ;
              }
              running = true;
              do {
                result = null;
                if (q.length > 0 && q[0].timestamp - scheduler.now() <= 0) {
                  result = q.shift().value;
                }
                if (result !== null) {
                  result.accept(observer);
                }
              } while (result !== null);
              shouldRecurse = false;
              recurseDueTime = 0;
              if (q.length > 0) {
                shouldRecurse = true;
                recurseDueTime = Math.max(0, q[0].timestamp - scheduler.now());
              } else {
                active = false;
              }
              e = exception;
              running = false;
              if (e !== null) {
                observer.onError(e);
              } else if (shouldRecurse) {
                self(recurseDueTime);
              }
            }));
          }
        }
      });
      return new CompositeDisposable(subscription, cancelable);
    }, source);
  }
  function observableDelayDate(source, dueTime, scheduler) {
    return observableDefer(function() {
      return observableDelayTimeSpan(source, dueTime - scheduler.now(), scheduler);
    });
  }
  observableProto.delay = function(dueTime, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return dueTime instanceof Date ? observableDelayDate(this, dueTime.getTime(), scheduler) : observableDelayTimeSpan(this, dueTime, scheduler);
  };
  observableProto.debounce = observableProto.throttleWithTimeout = function(dueTime, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var source = this;
    return new AnonymousObservable(function(observer) {
      var cancelable = new SerialDisposable(),
          hasvalue = false,
          value,
          id = 0;
      var subscription = source.subscribe(function(x) {
        hasvalue = true;
        value = x;
        id++;
        var currentId = id,
            d = new SingleAssignmentDisposable();
        cancelable.setDisposable(d);
        d.setDisposable(scheduler.scheduleWithRelative(dueTime, function() {
          hasvalue && id === currentId && observer.onNext(value);
          hasvalue = false;
        }));
      }, function(e) {
        cancelable.dispose();
        observer.onError(e);
        hasvalue = false;
        id++;
      }, function() {
        cancelable.dispose();
        hasvalue && observer.onNext(value);
        observer.onCompleted();
        hasvalue = false;
        id++;
      });
      return new CompositeDisposable(subscription, cancelable);
    }, this);
  };
  observableProto.throttle = function(dueTime, scheduler) {
    return this.debounce(dueTime, scheduler);
  };
  observableProto.windowWithTime = function(timeSpan, timeShiftOrScheduler, scheduler) {
    var source = this,
        timeShift;
    timeShiftOrScheduler == null && (timeShift = timeSpan);
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    if (typeof timeShiftOrScheduler === 'number') {
      timeShift = timeShiftOrScheduler;
    } else if (isScheduler(timeShiftOrScheduler)) {
      timeShift = timeSpan;
      scheduler = timeShiftOrScheduler;
    }
    return new AnonymousObservable(function(observer) {
      var groupDisposable,
          nextShift = timeShift,
          nextSpan = timeSpan,
          q = [],
          refCountDisposable,
          timerD = new SerialDisposable(),
          totalTime = 0;
      groupDisposable = new CompositeDisposable(timerD), refCountDisposable = new RefCountDisposable(groupDisposable);
      function createTimer() {
        var m = new SingleAssignmentDisposable(),
            isSpan = false,
            isShift = false;
        timerD.setDisposable(m);
        if (nextSpan === nextShift) {
          isSpan = true;
          isShift = true;
        } else if (nextSpan < nextShift) {
          isSpan = true;
        } else {
          isShift = true;
        }
        var newTotalTime = isSpan ? nextSpan : nextShift,
            ts = newTotalTime - totalTime;
        totalTime = newTotalTime;
        if (isSpan) {
          nextSpan += timeShift;
        }
        if (isShift) {
          nextShift += timeShift;
        }
        m.setDisposable(scheduler.scheduleWithRelative(ts, function() {
          if (isShift) {
            var s = new Subject();
            q.push(s);
            observer.onNext(addRef(s, refCountDisposable));
          }
          isSpan && q.shift().onCompleted();
          createTimer();
        }));
      }
      ;
      q.push(new Subject());
      observer.onNext(addRef(q[0], refCountDisposable));
      createTimer();
      groupDisposable.add(source.subscribe(function(x) {
        for (var i = 0,
            len = q.length; i < len; i++) {
          q[i].onNext(x);
        }
      }, function(e) {
        for (var i = 0,
            len = q.length; i < len; i++) {
          q[i].onError(e);
        }
        observer.onError(e);
      }, function() {
        for (var i = 0,
            len = q.length; i < len; i++) {
          q[i].onCompleted();
        }
        observer.onCompleted();
      }));
      return refCountDisposable;
    }, source);
  };
  observableProto.windowWithTimeOrCount = function(timeSpan, count, scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(observer) {
      var timerD = new SerialDisposable(),
          groupDisposable = new CompositeDisposable(timerD),
          refCountDisposable = new RefCountDisposable(groupDisposable),
          n = 0,
          windowId = 0,
          s = new Subject();
      function createTimer(id) {
        var m = new SingleAssignmentDisposable();
        timerD.setDisposable(m);
        m.setDisposable(scheduler.scheduleWithRelative(timeSpan, function() {
          if (id !== windowId) {
            return ;
          }
          n = 0;
          var newId = ++windowId;
          s.onCompleted();
          s = new Subject();
          observer.onNext(addRef(s, refCountDisposable));
          createTimer(newId);
        }));
      }
      observer.onNext(addRef(s, refCountDisposable));
      createTimer(0);
      groupDisposable.add(source.subscribe(function(x) {
        var newId = 0,
            newWindow = false;
        s.onNext(x);
        if (++n === count) {
          newWindow = true;
          n = 0;
          newId = ++windowId;
          s.onCompleted();
          s = new Subject();
          observer.onNext(addRef(s, refCountDisposable));
        }
        newWindow && createTimer(newId);
      }, function(e) {
        s.onError(e);
        observer.onError(e);
      }, function() {
        s.onCompleted();
        observer.onCompleted();
      }));
      return refCountDisposable;
    }, source);
  };
  observableProto.bufferWithTime = function(timeSpan, timeShiftOrScheduler, scheduler) {
    return this.windowWithTime.apply(this, arguments).selectMany(function(x) {
      return x.toArray();
    });
  };
  observableProto.bufferWithTimeOrCount = function(timeSpan, count, scheduler) {
    return this.windowWithTimeOrCount(timeSpan, count, scheduler).selectMany(function(x) {
      return x.toArray();
    });
  };
  observableProto.timeInterval = function(scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return observableDefer(function() {
      var last = scheduler.now();
      return source.map(function(x) {
        var now = scheduler.now(),
            span = now - last;
        last = now;
        return {
          value: x,
          interval: span
        };
      });
    });
  };
  observableProto.timestamp = function(scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return this.map(function(x) {
      return {
        value: x,
        timestamp: scheduler.now()
      };
    });
  };
  function sampleObservable(source, sampler) {
    return new AnonymousObservable(function(observer) {
      var atEnd,
          value,
          hasValue;
      function sampleSubscribe() {
        if (hasValue) {
          hasValue = false;
          observer.onNext(value);
        }
        atEnd && observer.onCompleted();
      }
      return new CompositeDisposable(source.subscribe(function(newValue) {
        hasValue = true;
        value = newValue;
      }, observer.onError.bind(observer), function() {
        atEnd = true;
      }), sampler.subscribe(sampleSubscribe, observer.onError.bind(observer), sampleSubscribe));
    }, source);
  }
  observableProto.sample = observableProto.throttleLatest = function(intervalOrSampler, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return typeof intervalOrSampler === 'number' ? sampleObservable(this, observableinterval(intervalOrSampler, scheduler)) : sampleObservable(this, intervalOrSampler);
  };
  observableProto.timeout = function(dueTime, other, scheduler) {
    (other == null || typeof other === 'string') && (other = observableThrow(new Error(other || 'Timeout')));
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var source = this,
        schedulerMethod = dueTime instanceof Date ? 'scheduleWithAbsolute' : 'scheduleWithRelative';
    return new AnonymousObservable(function(observer) {
      var id = 0,
          original = new SingleAssignmentDisposable(),
          subscription = new SerialDisposable(),
          switched = false,
          timer = new SerialDisposable();
      subscription.setDisposable(original);
      function createTimer() {
        var myId = id;
        timer.setDisposable(scheduler[schedulerMethod](dueTime, function() {
          if (id === myId) {
            isPromise(other) && (other = observableFromPromise(other));
            subscription.setDisposable(other.subscribe(observer));
          }
        }));
      }
      createTimer();
      original.setDisposable(source.subscribe(function(x) {
        if (!switched) {
          id++;
          observer.onNext(x);
          createTimer();
        }
      }, function(e) {
        if (!switched) {
          id++;
          observer.onError(e);
        }
      }, function() {
        if (!switched) {
          id++;
          observer.onCompleted();
        }
      }));
      return new CompositeDisposable(subscription, timer);
    }, source);
  };
  Observable.generateWithAbsoluteTime = function(initialState, condition, iterate, resultSelector, timeSelector, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(observer) {
      var first = true,
          hasResult = false,
          result,
          state = initialState,
          time;
      return scheduler.scheduleRecursiveWithAbsolute(scheduler.now(), function(self) {
        hasResult && observer.onNext(result);
        try {
          if (first) {
            first = false;
          } else {
            state = iterate(state);
          }
          hasResult = condition(state);
          if (hasResult) {
            result = resultSelector(state);
            time = timeSelector(state);
          }
        } catch (e) {
          observer.onError(e);
          return ;
        }
        if (hasResult) {
          self(time);
        } else {
          observer.onCompleted();
        }
      });
    });
  };
  Observable.generateWithRelativeTime = function(initialState, condition, iterate, resultSelector, timeSelector, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(observer) {
      var first = true,
          hasResult = false,
          result,
          state = initialState,
          time;
      return scheduler.scheduleRecursiveWithRelative(0, function(self) {
        hasResult && observer.onNext(result);
        try {
          if (first) {
            first = false;
          } else {
            state = iterate(state);
          }
          hasResult = condition(state);
          if (hasResult) {
            result = resultSelector(state);
            time = timeSelector(state);
          }
        } catch (e) {
          observer.onError(e);
          return ;
        }
        if (hasResult) {
          self(time);
        } else {
          observer.onCompleted();
        }
      });
    });
  };
  observableProto.delaySubscription = function(dueTime, scheduler) {
    return this.delayWithSelector(observableTimer(dueTime, isScheduler(scheduler) ? scheduler : timeoutScheduler), observableEmpty);
  };
  observableProto.delayWithSelector = function(subscriptionDelay, delayDurationSelector) {
    var source = this,
        subDelay,
        selector;
    if (typeof subscriptionDelay === 'function') {
      selector = subscriptionDelay;
    } else {
      subDelay = subscriptionDelay;
      selector = delayDurationSelector;
    }
    return new AnonymousObservable(function(observer) {
      var delays = new CompositeDisposable(),
          atEnd = false,
          done = function() {
            if (atEnd && delays.length === 0) {
              observer.onCompleted();
            }
          },
          subscription = new SerialDisposable(),
          start = function() {
            subscription.setDisposable(source.subscribe(function(x) {
              var delay;
              try {
                delay = selector(x);
              } catch (error) {
                observer.onError(error);
                return ;
              }
              var d = new SingleAssignmentDisposable();
              delays.add(d);
              d.setDisposable(delay.subscribe(function() {
                observer.onNext(x);
                delays.remove(d);
                done();
              }, observer.onError.bind(observer), function() {
                observer.onNext(x);
                delays.remove(d);
                done();
              }));
            }, observer.onError.bind(observer), function() {
              atEnd = true;
              subscription.dispose();
              done();
            }));
          };
      if (!subDelay) {
        start();
      } else {
        subscription.setDisposable(subDelay.subscribe(start, observer.onError.bind(observer), start));
      }
      return new CompositeDisposable(subscription, delays);
    }, this);
  };
  observableProto.timeoutWithSelector = function(firstTimeout, timeoutdurationSelector, other) {
    if (arguments.length === 1) {
      timeoutdurationSelector = firstTimeout;
      firstTimeout = observableNever();
    }
    other || (other = observableThrow(new Error('Timeout')));
    var source = this;
    return new AnonymousObservable(function(observer) {
      var subscription = new SerialDisposable(),
          timer = new SerialDisposable(),
          original = new SingleAssignmentDisposable();
      subscription.setDisposable(original);
      var id = 0,
          switched = false;
      function setTimer(timeout) {
        var myId = id;
        function timerWins() {
          return id === myId;
        }
        var d = new SingleAssignmentDisposable();
        timer.setDisposable(d);
        d.setDisposable(timeout.subscribe(function() {
          timerWins() && subscription.setDisposable(other.subscribe(observer));
          d.dispose();
        }, function(e) {
          timerWins() && observer.onError(e);
        }, function() {
          timerWins() && subscription.setDisposable(other.subscribe(observer));
        }));
      }
      ;
      setTimer(firstTimeout);
      function observerWins() {
        var res = !switched;
        if (res) {
          id++;
        }
        return res;
      }
      original.setDisposable(source.subscribe(function(x) {
        if (observerWins()) {
          observer.onNext(x);
          var timeout;
          try {
            timeout = timeoutdurationSelector(x);
          } catch (e) {
            observer.onError(e);
            return ;
          }
          setTimer(isPromise(timeout) ? observableFromPromise(timeout) : timeout);
        }
      }, function(e) {
        observerWins() && observer.onError(e);
      }, function() {
        observerWins() && observer.onCompleted();
      }));
      return new CompositeDisposable(subscription, timer);
    }, source);
  };
  observableProto.debounceWithSelector = function(durationSelector) {
    var source = this;
    return new AnonymousObservable(function(observer) {
      var value,
          hasValue = false,
          cancelable = new SerialDisposable(),
          id = 0;
      var subscription = source.subscribe(function(x) {
        var throttle;
        try {
          throttle = durationSelector(x);
        } catch (e) {
          observer.onError(e);
          return ;
        }
        isPromise(throttle) && (throttle = observableFromPromise(throttle));
        hasValue = true;
        value = x;
        id++;
        var currentid = id,
            d = new SingleAssignmentDisposable();
        cancelable.setDisposable(d);
        d.setDisposable(throttle.subscribe(function() {
          hasValue && id === currentid && observer.onNext(value);
          hasValue = false;
          d.dispose();
        }, observer.onError.bind(observer), function() {
          hasValue && id === currentid && observer.onNext(value);
          hasValue = false;
          d.dispose();
        }));
      }, function(e) {
        cancelable.dispose();
        observer.onError(e);
        hasValue = false;
        id++;
      }, function() {
        cancelable.dispose();
        hasValue && observer.onNext(value);
        observer.onCompleted();
        hasValue = false;
        id++;
      });
      return new CompositeDisposable(subscription, cancelable);
    }, source);
  };
  observableProto.throttleWithSelector = function() {
    return this.debounceWithSelector.apply(this, arguments);
  };
  observableProto.skipLastWithTime = function(duration, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var source = this;
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        var now = scheduler.now();
        q.push({
          interval: now,
          value: x
        });
        while (q.length > 0 && now - q[0].interval >= duration) {
          o.onNext(q.shift().value);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        var now = scheduler.now();
        while (q.length > 0 && now - q[0].interval >= duration) {
          o.onNext(q.shift().value);
        }
        o.onCompleted();
      });
    }, source);
  };
  observableProto.takeLastWithTime = function(duration, scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        var now = scheduler.now();
        q.push({
          interval: now,
          value: x
        });
        while (q.length > 0 && now - q[0].interval >= duration) {
          q.shift();
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        var now = scheduler.now();
        while (q.length > 0) {
          var next = q.shift();
          if (now - next.interval <= duration) {
            o.onNext(next.value);
          }
        }
        o.onCompleted();
      });
    }, source);
  };
  observableProto.takeLastBufferWithTime = function(duration, scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(o) {
      var q = [];
      return source.subscribe(function(x) {
        var now = scheduler.now();
        q.push({
          interval: now,
          value: x
        });
        while (q.length > 0 && now - q[0].interval >= duration) {
          q.shift();
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        var now = scheduler.now(),
            res = [];
        while (q.length > 0) {
          var next = q.shift();
          now - next.interval <= duration && res.push(next.value);
        }
        o.onNext(res);
        o.onCompleted();
      });
    }, source);
  };
  observableProto.takeWithTime = function(duration, scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(o) {
      return new CompositeDisposable(scheduler.scheduleWithRelative(duration, function() {
        o.onCompleted();
      }), source.subscribe(o));
    }, source);
  };
  observableProto.skipWithTime = function(duration, scheduler) {
    var source = this;
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    return new AnonymousObservable(function(observer) {
      var open = false;
      return new CompositeDisposable(scheduler.scheduleWithRelative(duration, function() {
        open = true;
      }), source.subscribe(function(x) {
        open && observer.onNext(x);
      }, observer.onError.bind(observer), observer.onCompleted.bind(observer)));
    }, source);
  };
  observableProto.skipUntilWithTime = function(startTime, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var source = this,
        schedulerMethod = startTime instanceof Date ? 'scheduleWithAbsolute' : 'scheduleWithRelative';
    return new AnonymousObservable(function(o) {
      var open = false;
      return new CompositeDisposable(scheduler[schedulerMethod](startTime, function() {
        open = true;
      }), source.subscribe(function(x) {
        open && o.onNext(x);
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      }));
    }, source);
  };
  observableProto.takeUntilWithTime = function(endTime, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var source = this,
        schedulerMethod = endTime instanceof Date ? 'scheduleWithAbsolute' : 'scheduleWithRelative';
    return new AnonymousObservable(function(o) {
      return new CompositeDisposable(scheduler[schedulerMethod](endTime, function() {
        o.onCompleted();
      }), source.subscribe(o));
    }, source);
  };
  observableProto.throttleFirst = function(windowDuration, scheduler) {
    isScheduler(scheduler) || (scheduler = timeoutScheduler);
    var duration = +windowDuration || 0;
    if (duration <= 0) {
      throw new RangeError('windowDuration cannot be less or equal zero.');
    }
    var source = this;
    return new AnonymousObservable(function(o) {
      var lastOnNext = 0;
      return source.subscribe(function(x) {
        var now = scheduler.now();
        if (lastOnNext === 0 || now - lastOnNext >= duration) {
          lastOnNext = now;
          o.onNext(x);
        }
      }, function(e) {
        o.onError(e);
      }, function() {
        o.onCompleted();
      });
    }, source);
  };
  observableProto.transduce = function(transducer) {
    var source = this;
    function transformForObserver(observer) {
      return {
        init: function() {
          return observer;
        },
        step: function(obs, input) {
          return obs.onNext(input);
        },
        result: function(obs) {
          return obs.onCompleted();
        }
      };
    }
    return new AnonymousObservable(function(observer) {
      var xform = transducer(transformForObserver(observer));
      return source.subscribe(function(v) {
        try {
          xform.step(observer, v);
        } catch (e) {
          observer.onError(e);
        }
      }, observer.onError.bind(observer), function() {
        xform.result(observer);
      });
    }, source);
  };
  observableProto.exclusive = function() {
    var sources = this;
    return new AnonymousObservable(function(observer) {
      var hasCurrent = false,
          isStopped = false,
          m = new SingleAssignmentDisposable(),
          g = new CompositeDisposable();
      g.add(m);
      m.setDisposable(sources.subscribe(function(innerSource) {
        if (!hasCurrent) {
          hasCurrent = true;
          isPromise(innerSource) && (innerSource = observableFromPromise(innerSource));
          var innerSubscription = new SingleAssignmentDisposable();
          g.add(innerSubscription);
          innerSubscription.setDisposable(innerSource.subscribe(observer.onNext.bind(observer), observer.onError.bind(observer), function() {
            g.remove(innerSubscription);
            hasCurrent = false;
            if (isStopped && g.length === 1) {
              observer.onCompleted();
            }
          }));
        }
      }, observer.onError.bind(observer), function() {
        isStopped = true;
        if (!hasCurrent && g.length === 1) {
          observer.onCompleted();
        }
      }));
      return g;
    }, this);
  };
  observableProto.exclusiveMap = function(selector, thisArg) {
    var sources = this,
        selectorFunc = bindCallback(selector, thisArg, 3);
    return new AnonymousObservable(function(observer) {
      var index = 0,
          hasCurrent = false,
          isStopped = true,
          m = new SingleAssignmentDisposable(),
          g = new CompositeDisposable();
      g.add(m);
      m.setDisposable(sources.subscribe(function(innerSource) {
        if (!hasCurrent) {
          hasCurrent = true;
          innerSubscription = new SingleAssignmentDisposable();
          g.add(innerSubscription);
          isPromise(innerSource) && (innerSource = observableFromPromise(innerSource));
          innerSubscription.setDisposable(innerSource.subscribe(function(x) {
            var result;
            try {
              result = selectorFunc(x, index++, innerSource);
            } catch (e) {
              observer.onError(e);
              return ;
            }
            observer.onNext(result);
          }, function(e) {
            observer.onError(e);
          }, function() {
            g.remove(innerSubscription);
            hasCurrent = false;
            if (isStopped && g.length === 1) {
              observer.onCompleted();
            }
          }));
        }
      }, function(e) {
        observer.onError(e);
      }, function() {
        isStopped = true;
        if (g.length === 1 && !hasCurrent) {
          observer.onCompleted();
        }
      }));
      return g;
    }, this);
  };
  Rx.VirtualTimeScheduler = (function(__super__) {
    function localNow() {
      return this.toDateTimeOffset(this.clock);
    }
    function scheduleNow(state, action) {
      return this.scheduleAbsoluteWithState(state, this.clock, action);
    }
    function scheduleRelative(state, dueTime, action) {
      return this.scheduleRelativeWithState(state, this.toRelative(dueTime), action);
    }
    function scheduleAbsolute(state, dueTime, action) {
      return this.scheduleRelativeWithState(state, this.toRelative(dueTime - this.now()), action);
    }
    function invokeAction(scheduler, action) {
      action();
      return disposableEmpty;
    }
    inherits(VirtualTimeScheduler, __super__);
    function VirtualTimeScheduler(initialClock, comparer) {
      this.clock = initialClock;
      this.comparer = comparer;
      this.isEnabled = false;
      this.queue = new PriorityQueue(1024);
      __super__.call(this, localNow, scheduleNow, scheduleRelative, scheduleAbsolute);
    }
    var VirtualTimeSchedulerPrototype = VirtualTimeScheduler.prototype;
    VirtualTimeSchedulerPrototype.add = notImplemented;
    VirtualTimeSchedulerPrototype.toDateTimeOffset = notImplemented;
    VirtualTimeSchedulerPrototype.toRelative = notImplemented;
    VirtualTimeSchedulerPrototype.schedulePeriodicWithState = function(state, period, action) {
      var s = new SchedulePeriodicRecursive(this, state, period, action);
      return s.start();
    };
    VirtualTimeSchedulerPrototype.scheduleRelativeWithState = function(state, dueTime, action) {
      var runAt = this.add(this.clock, dueTime);
      return this.scheduleAbsoluteWithState(state, runAt, action);
    };
    VirtualTimeSchedulerPrototype.scheduleRelative = function(dueTime, action) {
      return this.scheduleRelativeWithState(action, dueTime, invokeAction);
    };
    VirtualTimeSchedulerPrototype.start = function() {
      if (!this.isEnabled) {
        this.isEnabled = true;
        do {
          var next = this.getNext();
          if (next !== null) {
            this.comparer(next.dueTime, this.clock) > 0 && (this.clock = next.dueTime);
            next.invoke();
          } else {
            this.isEnabled = false;
          }
        } while (this.isEnabled);
      }
    };
    VirtualTimeSchedulerPrototype.stop = function() {
      this.isEnabled = false;
    };
    VirtualTimeSchedulerPrototype.advanceTo = function(time) {
      var dueToClock = this.comparer(this.clock, time);
      if (this.comparer(this.clock, time) > 0) {
        throw new ArgumentOutOfRangeError();
      }
      if (dueToClock === 0) {
        return ;
      }
      if (!this.isEnabled) {
        this.isEnabled = true;
        do {
          var next = this.getNext();
          if (next !== null && this.comparer(next.dueTime, time) <= 0) {
            this.comparer(next.dueTime, this.clock) > 0 && (this.clock = next.dueTime);
            next.invoke();
          } else {
            this.isEnabled = false;
          }
        } while (this.isEnabled);
        this.clock = time;
      }
    };
    VirtualTimeSchedulerPrototype.advanceBy = function(time) {
      var dt = this.add(this.clock, time),
          dueToClock = this.comparer(this.clock, dt);
      if (dueToClock > 0) {
        throw new ArgumentOutOfRangeError();
      }
      if (dueToClock === 0) {
        return ;
      }
      this.advanceTo(dt);
    };
    VirtualTimeSchedulerPrototype.sleep = function(time) {
      var dt = this.add(this.clock, time);
      if (this.comparer(this.clock, dt) >= 0) {
        throw new ArgumentOutOfRangeError();
      }
      this.clock = dt;
    };
    VirtualTimeSchedulerPrototype.getNext = function() {
      while (this.queue.length > 0) {
        var next = this.queue.peek();
        if (next.isCancelled()) {
          this.queue.dequeue();
        } else {
          return next;
        }
      }
      return null;
    };
    VirtualTimeSchedulerPrototype.scheduleAbsolute = function(dueTime, action) {
      return this.scheduleAbsoluteWithState(action, dueTime, invokeAction);
    };
    VirtualTimeSchedulerPrototype.scheduleAbsoluteWithState = function(state, dueTime, action) {
      var self = this;
      function run(scheduler, state1) {
        self.queue.remove(si);
        return action(scheduler, state1);
      }
      var si = new ScheduledItem(this, state, run, dueTime, this.comparer);
      this.queue.enqueue(si);
      return si.disposable;
    };
    return VirtualTimeScheduler;
  }(Scheduler));
  Rx.HistoricalScheduler = (function(__super__) {
    inherits(HistoricalScheduler, __super__);
    function HistoricalScheduler(initialClock, comparer) {
      var clock = initialClock == null ? 0 : initialClock;
      var cmp = comparer || defaultSubComparer;
      __super__.call(this, clock, cmp);
    }
    var HistoricalSchedulerProto = HistoricalScheduler.prototype;
    HistoricalSchedulerProto.add = function(absolute, relative) {
      return absolute + relative;
    };
    HistoricalSchedulerProto.toDateTimeOffset = function(absolute) {
      return new Date(absolute).getTime();
    };
    HistoricalSchedulerProto.toRelative = function(timeSpan) {
      return timeSpan;
    };
    return HistoricalScheduler;
  }(Rx.VirtualTimeScheduler));
  var AnonymousObservable = Rx.AnonymousObservable = (function(__super__) {
    inherits(AnonymousObservable, __super__);
    function fixSubscriber(subscriber) {
      return subscriber && isFunction(subscriber.dispose) ? subscriber : isFunction(subscriber) ? disposableCreate(subscriber) : disposableEmpty;
    }
    function setDisposable(s, state) {
      var ado = state[0],
          subscribe = state[1];
      var sub = tryCatch(subscribe)(ado);
      if (sub === errorObj) {
        if (!ado.fail(errorObj.e)) {
          return thrower(errorObj.e);
        }
      }
      ado.setDisposable(fixSubscriber(sub));
    }
    function AnonymousObservable(subscribe, parent) {
      this.source = parent;
      function s(observer) {
        var ado = new AutoDetachObserver(observer),
            state = [ado, subscribe];
        if (currentThreadScheduler.scheduleRequired()) {
          currentThreadScheduler.scheduleWithState(state, setDisposable);
        } else {
          setDisposable(null, state);
        }
        return ado;
      }
      __super__.call(this, s);
    }
    return AnonymousObservable;
  }(Observable));
  var AutoDetachObserver = (function(__super__) {
    inherits(AutoDetachObserver, __super__);
    function AutoDetachObserver(observer) {
      __super__.call(this);
      this.observer = observer;
      this.m = new SingleAssignmentDisposable();
    }
    var AutoDetachObserverPrototype = AutoDetachObserver.prototype;
    AutoDetachObserverPrototype.next = function(value) {
      var result = tryCatch(this.observer.onNext).call(this.observer, value);
      if (result === errorObj) {
        this.dispose();
        thrower(result.e);
      }
    };
    AutoDetachObserverPrototype.error = function(err) {
      var result = tryCatch(this.observer.onError).call(this.observer, err);
      this.dispose();
      result === errorObj && thrower(result.e);
    };
    AutoDetachObserverPrototype.completed = function() {
      var result = tryCatch(this.observer.onCompleted).call(this.observer);
      this.dispose();
      result === errorObj && thrower(result.e);
    };
    AutoDetachObserverPrototype.setDisposable = function(value) {
      this.m.setDisposable(value);
    };
    AutoDetachObserverPrototype.getDisposable = function() {
      return this.m.getDisposable();
    };
    AutoDetachObserverPrototype.dispose = function() {
      __super__.prototype.dispose.call(this);
      this.m.dispose();
    };
    return AutoDetachObserver;
  }(AbstractObserver));
  var GroupedObservable = (function(__super__) {
    inherits(GroupedObservable, __super__);
    function subscribe(observer) {
      return this.underlyingObservable.subscribe(observer);
    }
    function GroupedObservable(key, underlyingObservable, mergedDisposable) {
      __super__.call(this, subscribe);
      this.key = key;
      this.underlyingObservable = !mergedDisposable ? underlyingObservable : new AnonymousObservable(function(observer) {
        return new CompositeDisposable(mergedDisposable.getDisposable(), underlyingObservable.subscribe(observer));
      });
    }
    return GroupedObservable;
  }(Observable));
  var Subject = Rx.Subject = (function(__super__) {
    function subscribe(observer) {
      checkDisposed(this);
      if (!this.isStopped) {
        this.observers.push(observer);
        return new InnerSubscription(this, observer);
      }
      if (this.hasError) {
        observer.onError(this.error);
        return disposableEmpty;
      }
      observer.onCompleted();
      return disposableEmpty;
    }
    inherits(Subject, __super__);
    function Subject() {
      __super__.call(this, subscribe);
      this.isDisposed = false, this.isStopped = false, this.observers = [];
      this.hasError = false;
    }
    addProperties(Subject.prototype, Observer.prototype, {
      hasObservers: function() {
        return this.observers.length > 0;
      },
      onCompleted: function() {
        checkDisposed(this);
        if (!this.isStopped) {
          this.isStopped = true;
          for (var i = 0,
              os = cloneArray(this.observers),
              len = os.length; i < len; i++) {
            os[i].onCompleted();
          }
          this.observers.length = 0;
        }
      },
      onError: function(error) {
        checkDisposed(this);
        if (!this.isStopped) {
          this.isStopped = true;
          this.error = error;
          this.hasError = true;
          for (var i = 0,
              os = cloneArray(this.observers),
              len = os.length; i < len; i++) {
            os[i].onError(error);
          }
          this.observers.length = 0;
        }
      },
      onNext: function(value) {
        checkDisposed(this);
        if (!this.isStopped) {
          for (var i = 0,
              os = cloneArray(this.observers),
              len = os.length; i < len; i++) {
            os[i].onNext(value);
          }
        }
      },
      dispose: function() {
        this.isDisposed = true;
        this.observers = null;
      }
    });
    Subject.create = function(observer, observable) {
      return new AnonymousSubject(observer, observable);
    };
    return Subject;
  }(Observable));
  var AsyncSubject = Rx.AsyncSubject = (function(__super__) {
    function subscribe(observer) {
      checkDisposed(this);
      if (!this.isStopped) {
        this.observers.push(observer);
        return new InnerSubscription(this, observer);
      }
      if (this.hasError) {
        observer.onError(this.error);
      } else if (this.hasValue) {
        observer.onNext(this.value);
        observer.onCompleted();
      } else {
        observer.onCompleted();
      }
      return disposableEmpty;
    }
    inherits(AsyncSubject, __super__);
    function AsyncSubject() {
      __super__.call(this, subscribe);
      this.isDisposed = false;
      this.isStopped = false;
      this.hasValue = false;
      this.observers = [];
      this.hasError = false;
    }
    addProperties(AsyncSubject.prototype, Observer, {
      hasObservers: function() {
        checkDisposed(this);
        return this.observers.length > 0;
      },
      onCompleted: function() {
        var i,
            len;
        checkDisposed(this);
        if (!this.isStopped) {
          this.isStopped = true;
          var os = cloneArray(this.observers),
              len = os.length;
          if (this.hasValue) {
            for (i = 0; i < len; i++) {
              var o = os[i];
              o.onNext(this.value);
              o.onCompleted();
            }
          } else {
            for (i = 0; i < len; i++) {
              os[i].onCompleted();
            }
          }
          this.observers.length = 0;
        }
      },
      onError: function(error) {
        checkDisposed(this);
        if (!this.isStopped) {
          this.isStopped = true;
          this.hasError = true;
          this.error = error;
          for (var i = 0,
              os = cloneArray(this.observers),
              len = os.length; i < len; i++) {
            os[i].onError(error);
          }
          this.observers.length = 0;
        }
      },
      onNext: function(value) {
        checkDisposed(this);
        if (this.isStopped) {
          return ;
        }
        this.value = value;
        this.hasValue = true;
      },
      dispose: function() {
        this.isDisposed = true;
        this.observers = null;
        this.exception = null;
        this.value = null;
      }
    });
    return AsyncSubject;
  }(Observable));
  var AnonymousSubject = Rx.AnonymousSubject = (function(__super__) {
    inherits(AnonymousSubject, __super__);
    function subscribe(observer) {
      return this.observable.subscribe(observer);
    }
    function AnonymousSubject(observer, observable) {
      this.observer = observer;
      this.observable = observable;
      __super__.call(this, subscribe);
    }
    addProperties(AnonymousSubject.prototype, Observer.prototype, {
      onCompleted: function() {
        this.observer.onCompleted();
      },
      onError: function(error) {
        this.observer.onError(error);
      },
      onNext: function(value) {
        this.observer.onNext(value);
      }
    });
    return AnonymousSubject;
  }(Observable));
  Rx.Pauser = (function(__super__) {
    inherits(Pauser, __super__);
    function Pauser() {
      __super__.call(this);
    }
    Pauser.prototype.pause = function() {
      this.onNext(false);
    };
    Pauser.prototype.resume = function() {
      this.onNext(true);
    };
    return Pauser;
  }(Subject));
  if (typeof define == 'function' && typeof define.amd == 'object' && define.amd) {
    root.Rx = Rx;
    System.register("rx/dist/rx.all", [], false, function() {
      return Rx;
    });
  } else if (freeExports && freeModule) {
    if (moduleExports) {
      (freeModule.exports = Rx).Rx = Rx;
    } else {
      freeExports.Rx = Rx;
    }
  } else {
    root.Rx = Rx;
  }
  var rEndingLine = captureLine();
}.call(this));
})();
System.register("angular2/src/facade/lang", [], function($__export) {
  "";
  var __moduleName = "angular2/src/facade/lang";
  var _global,
      Type,
      Math,
      Date,
      assertionsEnabled_,
      int,
      CONST,
      ABSTRACT,
      IMPLEMENTS,
      StringWrapper,
      StringJoiner,
      NumberParseError,
      NumberWrapper,
      RegExp,
      RegExpWrapper,
      RegExpMatcherWrapper,
      FunctionWrapper,
      BaseException,
      Json,
      DateWrapper;
  function isPresent(obj) {
    return obj !== undefined && obj !== null;
  }
  function isBlank(obj) {
    return obj === undefined || obj === null;
  }
  function isString(obj) {
    return typeof obj === "string";
  }
  function isFunction(obj) {
    return typeof obj === "function";
  }
  function stringify(token) {
    if (typeof token === 'string') {
      return token;
    }
    if (token === undefined || token === null) {
      return '' + token;
    }
    if (token.name) {
      return token.name;
    }
    return token.toString();
  }
  function looseIdentical(a, b) {
    return a === b || typeof a === "number" && typeof b === "number" && isNaN(a) && isNaN(b);
  }
  function getMapKey(value) {
    return value;
  }
  function normalizeBlank(obj) {
    return isBlank(obj) ? null : obj;
  }
  function isJsObject(o) {
    return o !== null && (typeof o === "function" || typeof o === "object");
  }
  function assertionsEnabled() {
    return assertionsEnabled_;
  }
  function print(obj) {
    if (obj instanceof Error) {
      console.log(obj.stack);
    } else {
      console.log(obj);
    }
  }
  $__export("isPresent", isPresent);
  $__export("isBlank", isBlank);
  $__export("isString", isString);
  $__export("isFunction", isFunction);
  $__export("stringify", stringify);
  $__export("looseIdentical", looseIdentical);
  $__export("getMapKey", getMapKey);
  $__export("normalizeBlank", normalizeBlank);
  $__export("isJsObject", isJsObject);
  $__export("assertionsEnabled", assertionsEnabled);
  $__export("print", print);
  return {
    setters: [],
    execute: function() {
      _global = typeof window === 'undefined' ? global : window;
      $__export("global", _global);
      Type = $__export("Type", Function);
      Math = $__export("Math", _global.Math);
      Date = $__export("Date", _global.Date);
      assertionsEnabled_ = typeof assert !== 'undefined';
      if (assertionsEnabled_) {
        _global.assert = assert;
        $__export("int", int = assert.define('int', function(value) {
          return typeof value === 'number' && value % 1 === 0;
        }));
      } else {
        $__export("int", int = {});
        _global.assert = function() {};
      }
      $__export("int", int);
      CONST = $__export("CONST", (function() {
        var CONST = function CONST() {
          ;
        };
        return ($traceurRuntime.createClass)(CONST, {}, {});
      }()));
      ABSTRACT = $__export("ABSTRACT", (function() {
        var ABSTRACT = function ABSTRACT() {
          ;
        };
        return ($traceurRuntime.createClass)(ABSTRACT, {}, {});
      }()));
      IMPLEMENTS = $__export("IMPLEMENTS", (function() {
        var IMPLEMENTS = function IMPLEMENTS() {
          ;
        };
        return ($traceurRuntime.createClass)(IMPLEMENTS, {}, {});
      }()));
      StringWrapper = $__export("StringWrapper", (function() {
        var StringWrapper = function StringWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(StringWrapper, {}, {
          fromCharCode: function(code) {
            return String.fromCharCode(code);
          },
          charCodeAt: function(s, index) {
            return s.charCodeAt(index);
          },
          split: function(s, regExp) {
            return s.split(regExp);
          },
          equals: function(s, s2) {
            return s === s2;
          },
          replace: function(s, from, replace) {
            return s.replace(from, replace);
          },
          replaceAll: function(s, from, replace) {
            return s.replace(from, replace);
          },
          startsWith: function(s, start) {
            return s.startsWith(start);
          },
          substring: function(s, start) {
            var end = arguments[2] !== (void 0) ? arguments[2] : null;
            return s.substring(start, end === null ? undefined : end);
          },
          replaceAllMapped: function(s, from, cb) {
            return s.replace(from, function() {
              for (var matches = [],
                  $__1 = 0; $__1 < arguments.length; $__1++)
                matches[$__1] = arguments[$__1];
              matches.splice(-2, 2);
              return cb(matches);
            });
          },
          contains: function(s, substr) {
            return s.indexOf(substr) != -1;
          }
        });
      }()));
      Object.defineProperty(StringWrapper.fromCharCode, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(StringWrapper.charCodeAt, "parameters", {get: function() {
          return [[assert.type.string], [int]];
        }});
      Object.defineProperty(StringWrapper.split, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(StringWrapper.equals, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(StringWrapper.replace, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(StringWrapper.replaceAll, "parameters", {get: function() {
          return [[assert.type.string], [RegExp], [assert.type.string]];
        }});
      Object.defineProperty(StringWrapper.startsWith, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(StringWrapper.substring, "parameters", {get: function() {
          return [[assert.type.string], [int], [int]];
        }});
      Object.defineProperty(StringWrapper.replaceAllMapped, "parameters", {get: function() {
          return [[assert.type.string], [RegExp], [Function]];
        }});
      Object.defineProperty(StringWrapper.contains, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      StringJoiner = $__export("StringJoiner", (function() {
        var StringJoiner = function StringJoiner() {
          this.parts = [];
        };
        return ($traceurRuntime.createClass)(StringJoiner, {
          add: function(part) {
            this.parts.push(part);
          },
          toString: function() {
            return this.parts.join("");
          }
        }, {});
      }()));
      Object.defineProperty(StringJoiner.prototype.add, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      NumberParseError = $__export("NumberParseError", (function($__super) {
        var NumberParseError = function NumberParseError(message) {
          $traceurRuntime.superConstructor(NumberParseError).call(this);
          this.message = message;
        };
        return ($traceurRuntime.createClass)(NumberParseError, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
      NumberWrapper = $__export("NumberWrapper", (function() {
        var NumberWrapper = function NumberWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(NumberWrapper, {}, {
          toFixed: function(n, fractionDigits) {
            return n.toFixed(fractionDigits);
          },
          equal: function(a, b) {
            return a === b;
          },
          parseIntAutoRadix: function(text) {
            var result = parseInt(text);
            if (isNaN(result)) {
              throw new NumberParseError("Invalid integer literal when parsing " + text);
            }
            return result;
          },
          parseInt: function(text, radix) {
            if (radix == 10) {
              if (/^(\-|\+)?[0-9]+$/.test(text)) {
                return parseInt(text, radix);
              }
            } else if (radix == 16) {
              if (/^(\-|\+)?[0-9ABCDEFabcdef]+$/.test(text)) {
                return parseInt(text, radix);
              }
            } else {
              var result = parseInt(text, radix);
              if (!isNaN(result)) {
                return result;
              }
            }
            throw new NumberParseError("Invalid integer literal when parsing " + text + " in base " + radix);
          },
          parseFloat: function(text) {
            return parseFloat(text);
          },
          get NaN() {
            return NaN;
          },
          isNaN: function(value) {
            return isNaN(value);
          },
          isInteger: function(value) {
            return Number.isInteger(value);
          }
        });
      }()));
      Object.defineProperty(NumberWrapper.toFixed, "parameters", {get: function() {
          return [[assert.type.number], [int]];
        }});
      Object.defineProperty(NumberWrapper.parseIntAutoRadix, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(NumberWrapper.parseInt, "parameters", {get: function() {
          return [[assert.type.string], [int]];
        }});
      Object.defineProperty(NumberWrapper.parseFloat, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      RegExp = $__export("RegExp", _global.RegExp);
      RegExpWrapper = $__export("RegExpWrapper", (function() {
        var RegExpWrapper = function RegExpWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(RegExpWrapper, {}, {
          create: function(regExpStr) {
            var flags = arguments[1] !== (void 0) ? arguments[1] : '';
            flags = flags.replace(/g/g, '');
            return new _global.RegExp(regExpStr, flags + 'g');
          },
          firstMatch: function(regExp, input) {
            regExp.lastIndex = 0;
            return regExp.exec(input);
          },
          matcher: function(regExp, input) {
            regExp.lastIndex = 0;
            return {
              re: regExp,
              input: input
            };
          }
        });
      }()));
      Object.defineProperty(RegExpWrapper.create, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      RegExpMatcherWrapper = $__export("RegExpMatcherWrapper", (function() {
        var RegExpMatcherWrapper = function RegExpMatcherWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(RegExpMatcherWrapper, {}, {next: function(matcher) {
            return matcher.re.exec(matcher.input);
          }});
      }()));
      FunctionWrapper = $__export("FunctionWrapper", (function() {
        var FunctionWrapper = function FunctionWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(FunctionWrapper, {}, {apply: function(fn, posArgs) {
            return fn.apply(null, posArgs);
          }});
      }()));
      Object.defineProperty(FunctionWrapper.apply, "parameters", {get: function() {
          return [[Function], []];
        }});
      BaseException = $__export("BaseException", Error);
      Json = $__export("Json", _global.JSON);
      DateWrapper = $__export("DateWrapper", (function() {
        var DateWrapper = function DateWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(DateWrapper, {}, {
          fromMillis: function(ms) {
            return new Date(ms);
          },
          toMillis: function(date) {
            return date.getTime();
          },
          now: function() {
            return new Date();
          },
          toJson: function(date) {
            return date.toJSON();
          }
        });
      }()));
      Object.defineProperty(DateWrapper.toMillis, "parameters", {get: function() {
          return [[Date]];
        }});
    }
  };
});

System.register("angular2/src/facade/collection", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/facade/collection";
  var int,
      isJsObject,
      global,
      List,
      Map,
      Set,
      StringMap,
      MapWrapper,
      StringMapWrapper,
      ListWrapper,
      SetWrapper;
  function isListLikeIterable(obj) {
    if (!isJsObject(obj))
      return false;
    return ListWrapper.isList(obj) || (!(obj instanceof Map) && Symbol.iterator in obj);
  }
  function iterateListLike(obj, fn) {
    if (ListWrapper.isList(obj)) {
      for (var i = 0; i < obj.length; i++) {
        fn(obj[i]);
      }
    } else {
      var iterator = obj[Symbol.iterator]();
      var item;
      while (!((item = iterator.next()).done)) {
        fn(item.value);
      }
    }
  }
  $__export("isListLikeIterable", isListLikeIterable);
  $__export("iterateListLike", iterateListLike);
  return {
    setters: [function($__m) {
      int = $__m.int;
      isJsObject = $__m.isJsObject;
      global = $__m.global;
    }],
    execute: function() {
      List = $__export("List", global.Array);
      Map = $__export("Map", global.Map);
      Set = $__export("Set", global.Set);
      StringMap = $__export("StringMap", global.Object);
      MapWrapper = $__export("MapWrapper", (function() {
        var MapWrapper = function MapWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(MapWrapper, {}, {
          create: function() {
            return new Map();
          },
          clone: function(m) {
            return new Map(m);
          },
          createFromStringMap: function(stringMap) {
            var result = MapWrapper.create();
            for (var prop in stringMap) {
              MapWrapper.set(result, prop, stringMap[prop]);
            }
            return result;
          },
          createFromPairs: function(pairs) {
            return new Map(pairs);
          },
          get: function(m, k) {
            return m.get(k);
          },
          set: function(m, k, v) {
            m.set(k, v);
          },
          contains: function(m, k) {
            return m.has(k);
          },
          forEach: function(m, fn) {
            m.forEach(fn);
          },
          size: function(m) {
            return m.size;
          },
          delete: function(m, k) {
            m.delete(k);
          },
          clear: function(m) {
            m.clear();
          },
          clearValues: function(m) {
            var keyIterator = m.keys();
            var k;
            while (!((k = keyIterator.next()).done)) {
              m.set(k.value, null);
            }
          },
          iterable: function(m) {
            return m;
          },
          keys: function(m) {
            return m.keys();
          },
          values: function(m) {
            return m.values();
          }
        });
      }()));
      Object.defineProperty(MapWrapper.clone, "parameters", {get: function() {
          return [[Map]];
        }});
      Object.defineProperty(MapWrapper.createFromPairs, "parameters", {get: function() {
          return [[List]];
        }});
      StringMapWrapper = $__export("StringMapWrapper", (function() {
        var StringMapWrapper = function StringMapWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(StringMapWrapper, {}, {
          create: function() {
            return {};
          },
          contains: function(map, key) {
            return map.hasOwnProperty(key);
          },
          get: function(map, key) {
            return map.hasOwnProperty(key) ? map[key] : undefined;
          },
          set: function(map, key, value) {
            map[key] = value;
          },
          isEmpty: function(map) {
            for (var prop in map) {
              return false;
            }
            return true;
          },
          delete: function(map, key) {
            delete map[key];
          },
          forEach: function(map, callback) {
            for (var prop in map) {
              if (map.hasOwnProperty(prop)) {
                callback(map[prop], prop);
              }
            }
          },
          merge: function(m1, m2) {
            var m = {};
            for (var attr in m1) {
              if (m1.hasOwnProperty(attr)) {
                m[attr] = m1[attr];
              }
            }
            for (var attr in m2) {
              if (m2.hasOwnProperty(attr)) {
                m[attr] = m2[attr];
              }
            }
            return m;
          }
        });
      }()));
      ListWrapper = $__export("ListWrapper", (function() {
        var ListWrapper = function ListWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(ListWrapper, {}, {
          create: function() {
            return new List();
          },
          createFixedSize: function(size) {
            return new List(size);
          },
          get: function(m, k) {
            return m[k];
          },
          set: function(m, k, v) {
            m[k] = v;
          },
          clone: function(array) {
            return array.slice(0);
          },
          map: function(array, fn) {
            return array.map(fn);
          },
          forEach: function(array, fn) {
            for (var i = 0; i < array.length; i++) {
              fn(array[i]);
            }
          },
          push: function(array, el) {
            array.push(el);
          },
          first: function(array) {
            if (!array)
              return null;
            return array[0];
          },
          last: function(array) {
            if (!array || array.length == 0)
              return null;
            return array[array.length - 1];
          },
          find: function(list, pred) {
            for (var i = 0; i < list.length; ++i) {
              if (pred(list[i]))
                return list[i];
            }
            return null;
          },
          reduce: function(list, fn, init) {
            return list.reduce(fn, init);
          },
          filter: function(array, pred) {
            return array.filter(pred);
          },
          any: function(list, pred) {
            for (var i = 0; i < list.length; ++i) {
              if (pred(list[i]))
                return true;
            }
            return false;
          },
          contains: function(list, el) {
            return list.indexOf(el) !== -1;
          },
          reversed: function(array) {
            var a = ListWrapper.clone(array);
            return a.reverse();
          },
          concat: function(a, b) {
            return a.concat(b);
          },
          isList: function(list) {
            return Array.isArray(list);
          },
          insert: function(list, index, value) {
            list.splice(index, 0, value);
          },
          removeAt: function(list, index) {
            var res = list[index];
            list.splice(index, 1);
            return res;
          },
          removeAll: function(list, items) {
            for (var i = 0; i < items.length; ++i) {
              var index = list.indexOf(items[i]);
              list.splice(index, 1);
            }
          },
          removeLast: function(list) {
            return list.pop();
          },
          remove: function(list, el) {
            var index = list.indexOf(el);
            if (index > -1) {
              list.splice(index, 1);
              return true;
            }
            return false;
          },
          clear: function(list) {
            list.splice(0, list.length);
          },
          join: function(list, s) {
            return list.join(s);
          },
          isEmpty: function(list) {
            return list.length == 0;
          },
          fill: function(list, value) {
            var start = arguments[2] !== (void 0) ? arguments[2] : 0;
            var end = arguments[3] !== (void 0) ? arguments[3] : null;
            list.fill(value, start, end === null ? undefined : end);
          },
          equals: function(a, b) {
            if (a.length != b.length)
              return false;
            for (var i = 0; i < a.length; ++i) {
              if (a[i] !== b[i])
                return false;
            }
            return true;
          },
          slice: function(l, from, to) {
            return l.slice(from, to);
          },
          sort: function(l, compareFn) {
            l.sort(compareFn);
          }
        });
      }()));
      Object.defineProperty(ListWrapper.clone, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(ListWrapper.forEach, "parameters", {get: function() {
          return [[List], [Function]];
        }});
      Object.defineProperty(ListWrapper.find, "parameters", {get: function() {
          return [[List], [Function]];
        }});
      Object.defineProperty(ListWrapper.reduce, "parameters", {get: function() {
          return [[List], [Function], []];
        }});
      Object.defineProperty(ListWrapper.filter, "parameters", {get: function() {
          return [[], [Function]];
        }});
      Object.defineProperty(ListWrapper.any, "parameters", {get: function() {
          return [[List], [Function]];
        }});
      Object.defineProperty(ListWrapper.contains, "parameters", {get: function() {
          return [[List], []];
        }});
      Object.defineProperty(ListWrapper.insert, "parameters", {get: function() {
          return [[], [int], []];
        }});
      Object.defineProperty(ListWrapper.removeAt, "parameters", {get: function() {
          return [[], [int]];
        }});
      Object.defineProperty(ListWrapper.removeLast, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(ListWrapper.fill, "parameters", {get: function() {
          return [[List], [], [int], [int]];
        }});
      Object.defineProperty(ListWrapper.equals, "parameters", {get: function() {
          return [[List], [List]];
        }});
      Object.defineProperty(ListWrapper.slice, "parameters", {get: function() {
          return [[List], [int], [int]];
        }});
      Object.defineProperty(ListWrapper.sort, "parameters", {get: function() {
          return [[List], [Function]];
        }});
      Object.defineProperty(iterateListLike, "parameters", {get: function() {
          return [[], [Function]];
        }});
      SetWrapper = $__export("SetWrapper", (function() {
        var SetWrapper = function SetWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(SetWrapper, {}, {
          createFromList: function(lst) {
            return new Set(lst);
          },
          has: function(s, key) {
            return s.has(key);
          }
        });
      }()));
      Object.defineProperty(SetWrapper.createFromList, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(SetWrapper.has, "parameters", {get: function() {
          return [[Set], []];
        }});
    }
  };
});

System.register("angular2/src/di/annotations", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/di/annotations";
  var CONST,
      Inject,
      InjectPromise,
      InjectLazy,
      Optional,
      DependencyAnnotation,
      Injectable;
  return {
    setters: [function($__m) {
      CONST = $__m.CONST;
    }],
    execute: function() {
      Inject = $__export("Inject", (function() {
        var Inject = function Inject(token) {
          this.token = token;
        };
        return ($traceurRuntime.createClass)(Inject, {}, {});
      }()));
      Object.defineProperty(Inject, "annotations", {get: function() {
          return [new CONST()];
        }});
      InjectPromise = $__export("InjectPromise", (function() {
        var InjectPromise = function InjectPromise(token) {
          this.token = token;
        };
        return ($traceurRuntime.createClass)(InjectPromise, {}, {});
      }()));
      Object.defineProperty(InjectPromise, "annotations", {get: function() {
          return [new CONST()];
        }});
      InjectLazy = $__export("InjectLazy", (function() {
        var InjectLazy = function InjectLazy(token) {
          this.token = token;
        };
        return ($traceurRuntime.createClass)(InjectLazy, {}, {});
      }()));
      Object.defineProperty(InjectLazy, "annotations", {get: function() {
          return [new CONST()];
        }});
      Optional = $__export("Optional", (function() {
        var Optional = function Optional() {};
        return ($traceurRuntime.createClass)(Optional, {}, {});
      }()));
      Object.defineProperty(Optional, "annotations", {get: function() {
          return [new CONST()];
        }});
      DependencyAnnotation = $__export("DependencyAnnotation", (function() {
        var DependencyAnnotation = function DependencyAnnotation() {};
        return ($traceurRuntime.createClass)(DependencyAnnotation, {get token() {
            return null;
          }}, {});
      }()));
      Object.defineProperty(DependencyAnnotation, "annotations", {get: function() {
          return [new CONST()];
        }});
      Injectable = $__export("Injectable", (function() {
        var Injectable = function Injectable() {};
        return ($traceurRuntime.createClass)(Injectable, {}, {});
      }()));
      Object.defineProperty(Injectable, "annotations", {get: function() {
          return [new CONST()];
        }});
    }
  };
});

System.register("angular2/src/reflection/types", [], function($__export) {
  "";
  var __moduleName = "angular2/src/reflection/types";
  var SetterFn,
      GetterFn,
      MethodFn;
  return {
    setters: [],
    execute: function() {
      SetterFn = $__export("SetterFn", Function);
      GetterFn = $__export("GetterFn", Function);
      MethodFn = $__export("MethodFn", Function);
    }
  };
});

System.register("angular2/src/reflection/reflection_capabilities", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/types"], function($__export) {
  "";
  var __moduleName = "angular2/src/reflection/reflection_capabilities";
  var Type,
      isPresent,
      List,
      ListWrapper,
      GetterFn,
      SetterFn,
      MethodFn,
      ReflectionCapabilities;
  return {
    setters: [function($__m) {
      Type = $__m.Type;
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      GetterFn = $__m.GetterFn;
      SetterFn = $__m.SetterFn;
      MethodFn = $__m.MethodFn;
    }],
    execute: function() {
      ReflectionCapabilities = $__export("ReflectionCapabilities", (function() {
        var ReflectionCapabilities = function ReflectionCapabilities() {
          ;
        };
        return ($traceurRuntime.createClass)(ReflectionCapabilities, {
          factory: function(type) {
            switch (type.length) {
              case 0:
                return function() {
                  return new type();
                };
              case 1:
                return function(a1) {
                  return new type(a1);
                };
              case 2:
                return function(a1, a2) {
                  return new type(a1, a2);
                };
              case 3:
                return function(a1, a2, a3) {
                  return new type(a1, a2, a3);
                };
              case 4:
                return function(a1, a2, a3, a4) {
                  return new type(a1, a2, a3, a4);
                };
              case 5:
                return function(a1, a2, a3, a4, a5) {
                  return new type(a1, a2, a3, a4, a5);
                };
              case 6:
                return function(a1, a2, a3, a4, a5, a6) {
                  return new type(a1, a2, a3, a4, a5, a6);
                };
              case 7:
                return function(a1, a2, a3, a4, a5, a6, a7) {
                  return new type(a1, a2, a3, a4, a5, a6, a7);
                };
              case 8:
                return function(a1, a2, a3, a4, a5, a6, a7, a8) {
                  return new type(a1, a2, a3, a4, a5, a6, a7, a8);
                };
              case 9:
                return function(a1, a2, a3, a4, a5, a6, a7, a8, a9) {
                  return new type(a1, a2, a3, a4, a5, a6, a7, a8, a9);
                };
              case 10:
                return function(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) {
                  return new type(a1, a2, a3, a4, a5, a6, a7, a8, a9, a10);
                };
            }
            ;
            throw new Error("Factory cannot take more than 10 arguments");
          },
          parameters: function(typeOfFunc) {
            return isPresent(typeOfFunc.parameters) ? typeOfFunc.parameters : ListWrapper.createFixedSize(typeOfFunc.length);
          },
          annotations: function(typeOfFunc) {
            return isPresent(typeOfFunc.annotations) ? typeOfFunc.annotations : [];
          },
          getter: function(name) {
            return new Function('o', 'return o.' + name + ';');
          },
          setter: function(name) {
            return new Function('o', 'v', 'return o.' + name + ' = v;');
          },
          method: function(name) {
            var method = ("o." + name);
            return new Function('o', 'args', ("if (!" + method + ") throw new Error('\"" + name + "\" is undefined');") + ("return " + method + ".apply(o, args);"));
          }
        }, {});
      }()));
      Object.defineProperty(ReflectionCapabilities.prototype.factory, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(ReflectionCapabilities.prototype.getter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ReflectionCapabilities.prototype.setter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ReflectionCapabilities.prototype.method, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/di/exceptions", ["angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/di/exceptions";
  var ListWrapper,
      List,
      stringify,
      KeyMetadataError,
      ProviderError,
      NoProviderError,
      AsyncBindingError,
      CyclicDependencyError,
      InstantiationError,
      InvalidBindingError,
      NoAnnotationError;
  function findFirstClosedCycle(keys) {
    var res = [];
    for (var i = 0; i < keys.length; ++i) {
      if (ListWrapper.contains(res, keys[i])) {
        ListWrapper.push(res, keys[i]);
        return res;
      } else {
        ListWrapper.push(res, keys[i]);
      }
    }
    return res;
  }
  function constructResolvingPath(keys) {
    if (keys.length > 1) {
      var reversed = findFirstClosedCycle(ListWrapper.reversed(keys));
      var tokenStrs = ListWrapper.map(reversed, (function(k) {
        return stringify(k.token);
      }));
      return " (" + tokenStrs.join(' -> ') + ")";
    } else {
      return "";
    }
  }
  return {
    setters: [function($__m) {
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
    }, function($__m) {
      stringify = $__m.stringify;
    }],
    execute: function() {
      Object.defineProperty(findFirstClosedCycle, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(constructResolvingPath, "parameters", {get: function() {
          return [[List]];
        }});
      KeyMetadataError = $__export("KeyMetadataError", (function($__super) {
        var KeyMetadataError = function KeyMetadataError() {
          $traceurRuntime.superConstructor(KeyMetadataError).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(KeyMetadataError, {}, {}, $__super);
      }(Error)));
      ProviderError = $__export("ProviderError", (function($__super) {
        var ProviderError = function ProviderError(key, constructResolvingMessage) {
          $traceurRuntime.superConstructor(ProviderError).call(this);
          this.keys = [key];
          this.constructResolvingMessage = constructResolvingMessage;
          this.message = this.constructResolvingMessage(this.keys);
        };
        return ($traceurRuntime.createClass)(ProviderError, {
          addKey: function(key) {
            ListWrapper.push(this.keys, key);
            this.message = this.constructResolvingMessage(this.keys);
          },
          toString: function() {
            return this.message;
          }
        }, {}, $__super);
      }(Error)));
      Object.defineProperty(ProviderError, "parameters", {get: function() {
          return [[], [Function]];
        }});
      NoProviderError = $__export("NoProviderError", (function($__super) {
        var NoProviderError = function NoProviderError(key) {
          $traceurRuntime.superConstructor(NoProviderError).call(this, key, function(keys) {
            var first = stringify(ListWrapper.first(keys).token);
            return ("No provider for " + first + "!" + constructResolvingPath(keys));
          });
        };
        return ($traceurRuntime.createClass)(NoProviderError, {}, {}, $__super);
      }(ProviderError)));
      AsyncBindingError = $__export("AsyncBindingError", (function($__super) {
        var AsyncBindingError = function AsyncBindingError(key) {
          $traceurRuntime.superConstructor(AsyncBindingError).call(this, key, function(keys) {
            var first = stringify(ListWrapper.first(keys).token);
            return ("Cannot instantiate " + first + " synchronously. ") + ("It is provided as a promise!" + constructResolvingPath(keys));
          });
        };
        return ($traceurRuntime.createClass)(AsyncBindingError, {}, {}, $__super);
      }(ProviderError)));
      CyclicDependencyError = $__export("CyclicDependencyError", (function($__super) {
        var CyclicDependencyError = function CyclicDependencyError(key) {
          $traceurRuntime.superConstructor(CyclicDependencyError).call(this, key, function(keys) {
            return ("Cannot instantiate cyclic dependency!" + constructResolvingPath(keys));
          });
        };
        return ($traceurRuntime.createClass)(CyclicDependencyError, {}, {}, $__super);
      }(ProviderError)));
      InstantiationError = $__export("InstantiationError", (function($__super) {
        var InstantiationError = function InstantiationError(originalException, key) {
          $traceurRuntime.superConstructor(InstantiationError).call(this, key, function(keys) {
            var first = stringify(ListWrapper.first(keys).token);
            return ("Error during instantiation of " + first + "!" + constructResolvingPath(keys) + ".") + (" ORIGINAL ERROR: " + originalException);
          });
        };
        return ($traceurRuntime.createClass)(InstantiationError, {}, {}, $__super);
      }(ProviderError)));
      InvalidBindingError = $__export("InvalidBindingError", (function($__super) {
        var InvalidBindingError = function InvalidBindingError(binding) {
          $traceurRuntime.superConstructor(InvalidBindingError).call(this);
          this.message = ("Invalid binding " + binding);
        };
        return ($traceurRuntime.createClass)(InvalidBindingError, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
      NoAnnotationError = $__export("NoAnnotationError", (function($__super) {
        var NoAnnotationError = function NoAnnotationError(typeOrFunc) {
          $traceurRuntime.superConstructor(NoAnnotationError).call(this);
          this.message = ("Cannot resolve all parameters for " + stringify(typeOrFunc));
        };
        return ($traceurRuntime.createClass)(NoAnnotationError, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
    }
  };
});

System.register("angular2/src/di/opaque_token", [], function($__export) {
  "";
  var __moduleName = "angular2/src/di/opaque_token";
  var OpaqueToken;
  return {
    setters: [],
    execute: function() {
      OpaqueToken = $__export("OpaqueToken", (function() {
        var OpaqueToken = function OpaqueToken(desc) {
          this._desc = ("Token(" + desc + ")");
        };
        return ($traceurRuntime.createClass)(OpaqueToken, {toString: function() {
            return this._desc;
          }}, {});
      }()));
      Object.defineProperty(OpaqueToken, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/parser/parser", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/parser/lexer", "angular2/src/reflection/reflection", "angular2/src/change_detection/parser/ast"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/parser/parser";
  var Injectable,
      int,
      isBlank,
      isPresent,
      BaseException,
      StringWrapper,
      RegExpWrapper,
      ListWrapper,
      List,
      Lexer,
      EOF,
      Token,
      $PERIOD,
      $COLON,
      $SEMICOLON,
      $LBRACKET,
      $RBRACKET,
      $COMMA,
      $LBRACE,
      $RBRACE,
      $LPAREN,
      $RPAREN,
      reflector,
      Reflector,
      AST,
      EmptyExpr,
      ImplicitReceiver,
      AccessMember,
      LiteralPrimitive,
      Expression,
      Binary,
      PrefixNot,
      Conditional,
      Pipe,
      Assignment,
      Chain,
      KeyedAccess,
      LiteralArray,
      LiteralMap,
      Interpolation,
      MethodCall,
      FunctionCall,
      TemplateBindings,
      TemplateBinding,
      ASTWithSource,
      _implicitReceiver,
      INTERPOLATION_REGEXP,
      QUOTE_REGEXP,
      Parser,
      _ParseAST;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      int = $__m.int;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      StringWrapper = $__m.StringWrapper;
      RegExpWrapper = $__m.RegExpWrapper;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
    }, function($__m) {
      Lexer = $__m.Lexer;
      EOF = $__m.EOF;
      Token = $__m.Token;
      $PERIOD = $__m.$PERIOD;
      $COLON = $__m.$COLON;
      $SEMICOLON = $__m.$SEMICOLON;
      $LBRACKET = $__m.$LBRACKET;
      $RBRACKET = $__m.$RBRACKET;
      $COMMA = $__m.$COMMA;
      $LBRACE = $__m.$LBRACE;
      $RBRACE = $__m.$RBRACE;
      $LPAREN = $__m.$LPAREN;
      $RPAREN = $__m.$RPAREN;
    }, function($__m) {
      reflector = $__m.reflector;
      Reflector = $__m.Reflector;
    }, function($__m) {
      AST = $__m.AST;
      EmptyExpr = $__m.EmptyExpr;
      ImplicitReceiver = $__m.ImplicitReceiver;
      AccessMember = $__m.AccessMember;
      LiteralPrimitive = $__m.LiteralPrimitive;
      Expression = $__m.Expression;
      Binary = $__m.Binary;
      PrefixNot = $__m.PrefixNot;
      Conditional = $__m.Conditional;
      Pipe = $__m.Pipe;
      Assignment = $__m.Assignment;
      Chain = $__m.Chain;
      KeyedAccess = $__m.KeyedAccess;
      LiteralArray = $__m.LiteralArray;
      LiteralMap = $__m.LiteralMap;
      Interpolation = $__m.Interpolation;
      MethodCall = $__m.MethodCall;
      FunctionCall = $__m.FunctionCall;
      TemplateBindings = $__m.TemplateBindings;
      TemplateBinding = $__m.TemplateBinding;
      ASTWithSource = $__m.ASTWithSource;
    }],
    execute: function() {
      _implicitReceiver = new ImplicitReceiver();
      INTERPOLATION_REGEXP = RegExpWrapper.create('\\{\\{(.*?)\\}\\}');
      QUOTE_REGEXP = RegExpWrapper.create("'");
      Parser = $__export("Parser", (function() {
        var Parser = function Parser(lexer) {
          var providedReflector = arguments[1] !== (void 0) ? arguments[1] : null;
          this._lexer = lexer;
          this._reflector = isPresent(providedReflector) ? providedReflector : reflector;
        };
        return ($traceurRuntime.createClass)(Parser, {
          parseAction: function(input, location) {
            var tokens = this._lexer.tokenize(input);
            var ast = new _ParseAST(input, location, tokens, this._reflector, true).parseChain();
            return new ASTWithSource(ast, input, location);
          },
          parseBinding: function(input, location) {
            var tokens = this._lexer.tokenize(input);
            var ast = new _ParseAST(input, location, tokens, this._reflector, false).parseChain();
            return new ASTWithSource(ast, input, location);
          },
          addPipes: function(bindingAst, pipes) {
            if (ListWrapper.isEmpty(pipes))
              return bindingAst;
            var res = ListWrapper.reduce(pipes, (function(result, currentPipeName) {
              return new Pipe(result, currentPipeName, [], false);
            }), bindingAst.ast);
            return new ASTWithSource(res, bindingAst.source, bindingAst.location);
          },
          parseTemplateBindings: function(input, location) {
            var tokens = this._lexer.tokenize(input);
            return new _ParseAST(input, location, tokens, this._reflector, false).parseTemplateBindings();
          },
          parseInterpolation: function(input, location) {
            var parts = StringWrapper.split(input, INTERPOLATION_REGEXP);
            if (parts.length <= 1) {
              return null;
            }
            var strings = [];
            var expressions = [];
            for (var i = 0; i < parts.length; i++) {
              var part = parts[i];
              if (i % 2 === 0) {
                ListWrapper.push(strings, part);
              } else {
                var tokens = this._lexer.tokenize(part);
                var ast = new _ParseAST(input, location, tokens, this._reflector, false).parseChain();
                ListWrapper.push(expressions, ast);
              }
            }
            return new ASTWithSource(new Interpolation(strings, expressions), input, location);
          },
          wrapLiteralPrimitive: function(input, location) {
            return new ASTWithSource(new LiteralPrimitive(input), input, location);
          }
        }, {});
      }()));
      Object.defineProperty(Parser, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(Parser, "parameters", {get: function() {
          return [[Lexer], [Reflector]];
        }});
      Object.defineProperty(Parser.prototype.parseAction, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      Object.defineProperty(Parser.prototype.parseBinding, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      Object.defineProperty(Parser.prototype.addPipes, "parameters", {get: function() {
          return [[ASTWithSource], [assert.genericType(List, String)]];
        }});
      Object.defineProperty(Parser.prototype.parseTemplateBindings, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      Object.defineProperty(Parser.prototype.parseInterpolation, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      Object.defineProperty(Parser.prototype.wrapLiteralPrimitive, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      _ParseAST = (function() {
        var _ParseAST = function _ParseAST(input, location, tokens, reflector, parseAction) {
          this.input = input;
          this.location = location;
          this.tokens = tokens;
          this.index = 0;
          this.reflector = reflector;
          this.parseAction = parseAction;
        };
        return ($traceurRuntime.createClass)(_ParseAST, {
          peek: function(offset) {
            var i = this.index + offset;
            return i < this.tokens.length ? this.tokens[i] : EOF;
          },
          get next() {
            return this.peek(0);
          },
          get inputIndex() {
            return (this.index < this.tokens.length) ? this.next.index : this.input.length;
          },
          advance: function() {
            this.index++;
          },
          optionalCharacter: function(code) {
            if (this.next.isCharacter(code)) {
              this.advance();
              return true;
            } else {
              return false;
            }
          },
          optionalKeywordVar: function() {
            if (this.peekKeywordVar()) {
              this.advance();
              return true;
            } else {
              return false;
            }
          },
          peekKeywordVar: function() {
            return this.next.isKeywordVar() || this.next.isOperator('#');
          },
          expectCharacter: function(code) {
            if (this.optionalCharacter(code))
              return ;
            this.error(("Missing expected " + StringWrapper.fromCharCode(code)));
          },
          optionalOperator: function(op) {
            if (this.next.isOperator(op)) {
              this.advance();
              return true;
            } else {
              return false;
            }
          },
          expectOperator: function(operator) {
            if (this.optionalOperator(operator))
              return ;
            this.error(("Missing expected operator " + operator));
          },
          expectIdentifierOrKeyword: function() {
            var n = this.next;
            if (!n.isIdentifier() && !n.isKeyword()) {
              this.error(("Unexpected token " + n + ", expected identifier or keyword"));
            }
            this.advance();
            return n.toString();
          },
          expectIdentifierOrKeywordOrString: function() {
            var n = this.next;
            if (!n.isIdentifier() && !n.isKeyword() && !n.isString()) {
              this.error(("Unexpected token " + n + ", expected identifier, keyword, or string"));
            }
            this.advance();
            return n.toString();
          },
          parseChain: function() {
            var exprs = [];
            while (this.index < this.tokens.length) {
              var expr = this.parsePipe();
              ListWrapper.push(exprs, expr);
              if (this.optionalCharacter($SEMICOLON)) {
                if (!this.parseAction) {
                  this.error("Binding expression cannot contain chained expression");
                }
                while (this.optionalCharacter($SEMICOLON)) {}
              } else if (this.index < this.tokens.length) {
                this.error(("Unexpected token '" + this.next + "'"));
              }
            }
            if (exprs.length == 0)
              return new EmptyExpr();
            if (exprs.length == 1)
              return exprs[0];
            return new Chain(exprs);
          },
          parsePipe: function() {
            var result = this.parseExpression();
            while (this.optionalOperator("|")) {
              if (this.parseAction) {
                this.error("Cannot have a pipe in an action expression");
              }
              var name = this.expectIdentifierOrKeyword();
              var args = ListWrapper.create();
              while (this.optionalCharacter($COLON)) {
                ListWrapper.push(args, this.parseExpression());
              }
              result = new Pipe(result, name, args, true);
            }
            return result;
          },
          parseExpression: function() {
            var start = this.inputIndex;
            var result = this.parseConditional();
            while (this.next.isOperator('=')) {
              if (!result.isAssignable) {
                var end = this.inputIndex;
                var expression = this.input.substring(start, end);
                this.error(("Expression " + expression + " is not assignable"));
              }
              if (!this.parseAction) {
                this.error("Binding expression cannot contain assignments");
              }
              this.expectOperator('=');
              result = new Assignment(result, this.parseConditional());
            }
            return result;
          },
          parseConditional: function() {
            var start = this.inputIndex;
            var result = this.parseLogicalOr();
            if (this.optionalOperator('?')) {
              var yes = this.parseExpression();
              if (!this.optionalCharacter($COLON)) {
                var end = this.inputIndex;
                var expression = this.input.substring(start, end);
                this.error(("Conditional expression " + expression + " requires all 3 expressions"));
              }
              var no = this.parseExpression();
              return new Conditional(result, yes, no);
            } else {
              return result;
            }
          },
          parseLogicalOr: function() {
            var result = this.parseLogicalAnd();
            while (this.optionalOperator('||')) {
              result = new Binary('||', result, this.parseLogicalAnd());
            }
            return result;
          },
          parseLogicalAnd: function() {
            var result = this.parseEquality();
            while (this.optionalOperator('&&')) {
              result = new Binary('&&', result, this.parseEquality());
            }
            return result;
          },
          parseEquality: function() {
            var result = this.parseRelational();
            while (true) {
              if (this.optionalOperator('==')) {
                result = new Binary('==', result, this.parseRelational());
              } else if (this.optionalOperator('!=')) {
                result = new Binary('!=', result, this.parseRelational());
              } else {
                return result;
              }
            }
          },
          parseRelational: function() {
            var result = this.parseAdditive();
            while (true) {
              if (this.optionalOperator('<')) {
                result = new Binary('<', result, this.parseAdditive());
              } else if (this.optionalOperator('>')) {
                result = new Binary('>', result, this.parseAdditive());
              } else if (this.optionalOperator('<=')) {
                result = new Binary('<=', result, this.parseAdditive());
              } else if (this.optionalOperator('>=')) {
                result = new Binary('>=', result, this.parseAdditive());
              } else {
                return result;
              }
            }
          },
          parseAdditive: function() {
            var result = this.parseMultiplicative();
            while (true) {
              if (this.optionalOperator('+')) {
                result = new Binary('+', result, this.parseMultiplicative());
              } else if (this.optionalOperator('-')) {
                result = new Binary('-', result, this.parseMultiplicative());
              } else {
                return result;
              }
            }
          },
          parseMultiplicative: function() {
            var result = this.parsePrefix();
            while (true) {
              if (this.optionalOperator('*')) {
                result = new Binary('*', result, this.parsePrefix());
              } else if (this.optionalOperator('%')) {
                result = new Binary('%', result, this.parsePrefix());
              } else if (this.optionalOperator('/')) {
                result = new Binary('/', result, this.parsePrefix());
              } else {
                return result;
              }
            }
          },
          parsePrefix: function() {
            if (this.optionalOperator('+')) {
              return this.parsePrefix();
            } else if (this.optionalOperator('-')) {
              return new Binary('-', new LiteralPrimitive(0), this.parsePrefix());
            } else if (this.optionalOperator('!')) {
              return new PrefixNot(this.parsePrefix());
            } else {
              return this.parseCallChain();
            }
          },
          parseCallChain: function() {
            var result = this.parsePrimary();
            while (true) {
              if (this.optionalCharacter($PERIOD)) {
                result = this.parseAccessMemberOrMethodCall(result);
              } else if (this.optionalCharacter($LBRACKET)) {
                var key = this.parseExpression();
                this.expectCharacter($RBRACKET);
                result = new KeyedAccess(result, key);
              } else if (this.optionalCharacter($LPAREN)) {
                var args = this.parseCallArguments();
                this.expectCharacter($RPAREN);
                result = new FunctionCall(result, args);
              } else {
                return result;
              }
            }
          },
          parsePrimary: function() {
            if (this.optionalCharacter($LPAREN)) {
              var result = this.parsePipe();
              this.expectCharacter($RPAREN);
              return result;
            } else if (this.next.isKeywordNull() || this.next.isKeywordUndefined()) {
              this.advance();
              return new LiteralPrimitive(null);
            } else if (this.next.isKeywordTrue()) {
              this.advance();
              return new LiteralPrimitive(true);
            } else if (this.next.isKeywordFalse()) {
              this.advance();
              return new LiteralPrimitive(false);
            } else if (this.optionalCharacter($LBRACKET)) {
              var elements = this.parseExpressionList($RBRACKET);
              this.expectCharacter($RBRACKET);
              return new LiteralArray(elements);
            } else if (this.next.isCharacter($LBRACE)) {
              return this.parseLiteralMap();
            } else if (this.next.isIdentifier()) {
              return this.parseAccessMemberOrMethodCall(_implicitReceiver);
            } else if (this.next.isNumber()) {
              var value = this.next.toNumber();
              this.advance();
              return new LiteralPrimitive(value);
            } else if (this.next.isString()) {
              var value = this.next.toString();
              this.advance();
              return new LiteralPrimitive(value);
            } else if (this.index >= this.tokens.length) {
              this.error(("Unexpected end of expression: " + this.input));
            } else {
              this.error(("Unexpected token " + this.next));
            }
          },
          parseExpressionList: function(terminator) {
            var result = [];
            if (!this.next.isCharacter(terminator)) {
              do {
                ListWrapper.push(result, this.parseExpression());
              } while (this.optionalCharacter($COMMA));
            }
            return result;
          },
          parseLiteralMap: function() {
            var keys = [];
            var values = [];
            this.expectCharacter($LBRACE);
            if (!this.optionalCharacter($RBRACE)) {
              do {
                var key = this.expectIdentifierOrKeywordOrString();
                ListWrapper.push(keys, key);
                this.expectCharacter($COLON);
                ListWrapper.push(values, this.parseExpression());
              } while (this.optionalCharacter($COMMA));
              this.expectCharacter($RBRACE);
            }
            return new LiteralMap(keys, values);
          },
          parseAccessMemberOrMethodCall: function(receiver) {
            var id = this.expectIdentifierOrKeyword();
            if (this.optionalCharacter($LPAREN)) {
              var args = this.parseCallArguments();
              this.expectCharacter($RPAREN);
              var fn = this.reflector.method(id);
              return new MethodCall(receiver, id, fn, args);
            } else {
              var getter = this.reflector.getter(id);
              var setter = this.reflector.setter(id);
              return new AccessMember(receiver, id, getter, setter);
            }
          },
          parseCallArguments: function() {
            if (this.next.isCharacter($RPAREN))
              return [];
            var positionals = [];
            do {
              ListWrapper.push(positionals, this.parseExpression());
            } while (this.optionalCharacter($COMMA));
            return positionals;
          },
          expectTemplateBindingKey: function() {
            var result = '';
            var operatorFound = false;
            do {
              result += this.expectIdentifierOrKeywordOrString();
              operatorFound = this.optionalOperator('-');
              if (operatorFound) {
                result += '-';
              }
            } while (operatorFound);
            return result.toString();
          },
          parseTemplateBindings: function() {
            var bindings = [];
            while (this.index < this.tokens.length) {
              var keyIsVar = this.optionalKeywordVar();
              var key = this.expectTemplateBindingKey();
              this.optionalCharacter($COLON);
              var name = null;
              var expression = null;
              if (this.next !== EOF) {
                if (keyIsVar) {
                  if (this.optionalOperator("=")) {
                    name = this.expectTemplateBindingKey();
                  } else {
                    name = '\$implicit';
                  }
                } else if (!this.peekKeywordVar()) {
                  var start = this.inputIndex;
                  var ast = this.parsePipe();
                  var source = this.input.substring(start, this.inputIndex);
                  expression = new ASTWithSource(ast, source, this.location);
                }
              }
              ListWrapper.push(bindings, new TemplateBinding(key, keyIsVar, name, expression));
              if (!this.optionalCharacter($SEMICOLON)) {
                this.optionalCharacter($COMMA);
              }
              ;
            }
            return bindings;
          },
          error: function(message) {
            var index = arguments[1] !== (void 0) ? arguments[1] : null;
            if (isBlank(index))
              index = this.index;
            var location = (index < this.tokens.length) ? ("at column " + (this.tokens[index].index + 1) + " in") : "at the end of the expression";
            throw new BaseException(("Parser Error: " + message + " " + location + " [" + this.input + "] in " + this.location));
          }
        }, {});
      }());
      Object.defineProperty(_ParseAST, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any], [List], [Reflector], [assert.type.boolean]];
        }});
      Object.defineProperty(_ParseAST.prototype.peek, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_ParseAST.prototype.optionalCharacter, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_ParseAST.prototype.expectCharacter, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_ParseAST.prototype.optionalOperator, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_ParseAST.prototype.expectOperator, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_ParseAST.prototype.parseExpressionList, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_ParseAST.prototype.error, "parameters", {get: function() {
          return [[assert.type.string], [int]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/parser/locals", ["angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/parser/locals";
  var isPresent,
      BaseException,
      ListWrapper,
      MapWrapper,
      Locals;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }],
    execute: function() {
      Locals = $__export("Locals", (function() {
        var Locals = function Locals(parent, current) {
          this.parent = parent;
          this.current = current;
        };
        return ($traceurRuntime.createClass)(Locals, {
          contains: function(name) {
            if (MapWrapper.contains(this.current, name)) {
              return true;
            }
            if (isPresent(this.parent)) {
              return this.parent.contains(name);
            }
            return false;
          },
          get: function(name) {
            if (MapWrapper.contains(this.current, name)) {
              return MapWrapper.get(this.current, name);
            }
            if (isPresent(this.parent)) {
              return this.parent.get(name);
            }
            throw new BaseException(("Cannot find '" + name + "'"));
          },
          set: function(name, value) {
            if (MapWrapper.contains(this.current, name)) {
              MapWrapper.set(this.current, name, value);
            } else {
              throw new BaseException('Setting of new keys post-construction is not supported.');
            }
          },
          clearValues: function() {
            MapWrapper.clearValues(this.current);
          }
        }, {});
      }()));
      Object.defineProperty(Locals, "parameters", {get: function() {
          return [[Locals], [Map]];
        }});
      Object.defineProperty(Locals.prototype.contains, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(Locals.prototype.get, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(Locals.prototype.set, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
    }
  };
});

System.register("angular2/src/change_detection/proto_record", ["angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/proto_record";
  var List,
      RECORD_TYPE_SELF,
      RECORD_TYPE_CONST,
      RECORD_TYPE_PRIMITIVE_OP,
      RECORD_TYPE_PROPERTY,
      RECORD_TYPE_LOCAL,
      RECORD_TYPE_INVOKE_METHOD,
      RECORD_TYPE_INVOKE_CLOSURE,
      RECORD_TYPE_KEYED_ACCESS,
      RECORD_TYPE_PIPE,
      RECORD_TYPE_BINDING_PIPE,
      RECORD_TYPE_INTERPOLATE,
      ProtoRecord;
  return {
    setters: [function($__m) {
      List = $__m.List;
    }],
    execute: function() {
      RECORD_TYPE_SELF = $__export("RECORD_TYPE_SELF", 0);
      RECORD_TYPE_CONST = $__export("RECORD_TYPE_CONST", 1);
      RECORD_TYPE_PRIMITIVE_OP = $__export("RECORD_TYPE_PRIMITIVE_OP", 2);
      RECORD_TYPE_PROPERTY = $__export("RECORD_TYPE_PROPERTY", 3);
      RECORD_TYPE_LOCAL = $__export("RECORD_TYPE_LOCAL", 4);
      RECORD_TYPE_INVOKE_METHOD = $__export("RECORD_TYPE_INVOKE_METHOD", 5);
      RECORD_TYPE_INVOKE_CLOSURE = $__export("RECORD_TYPE_INVOKE_CLOSURE", 6);
      RECORD_TYPE_KEYED_ACCESS = $__export("RECORD_TYPE_KEYED_ACCESS", 7);
      RECORD_TYPE_PIPE = $__export("RECORD_TYPE_PIPE", 8);
      RECORD_TYPE_BINDING_PIPE = $__export("RECORD_TYPE_BINDING_PIPE", 9);
      RECORD_TYPE_INTERPOLATE = $__export("RECORD_TYPE_INTERPOLATE", 10);
      ProtoRecord = $__export("ProtoRecord", (function() {
        var ProtoRecord = function ProtoRecord(mode, name, funcOrValue, args, fixedArgs, contextIndex, selfIndex, bindingMemento, directiveMemento, expressionAsString, lastInBinding, lastInDirective) {
          this.mode = mode;
          this.name = name;
          this.funcOrValue = funcOrValue;
          this.args = args;
          this.fixedArgs = fixedArgs;
          this.contextIndex = contextIndex;
          this.selfIndex = selfIndex;
          this.bindingMemento = bindingMemento;
          this.directiveMemento = directiveMemento;
          this.lastInBinding = lastInBinding;
          this.lastInDirective = lastInDirective;
          this.expressionAsString = expressionAsString;
        };
        return ($traceurRuntime.createClass)(ProtoRecord, {isPureFunction: function() {
            return this.mode === RECORD_TYPE_INTERPOLATE || this.mode === RECORD_TYPE_PRIMITIVE_OP;
          }}, {});
      }()));
      Object.defineProperty(ProtoRecord, "parameters", {get: function() {
          return [[assert.type.number], [assert.type.string], [], [List], [List], [assert.type.number], [assert.type.number], [assert.type.any], [assert.type.any], [assert.type.string], [assert.type.boolean], [assert.type.boolean]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/interfaces", ["angular2/src/facade/collection", "angular2/src/change_detection/parser/locals", "angular2/src/change_detection/parser/ast"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/interfaces";
  var List,
      Locals,
      AST,
      ProtoChangeDetector,
      ChangeDetection,
      ChangeRecord,
      ChangeDispatcher,
      ChangeDetector;
  return {
    setters: [function($__m) {
      List = $__m.List;
    }, function($__m) {
      Locals = $__m.Locals;
    }, function($__m) {
      AST = $__m.AST;
    }],
    execute: function() {
      ProtoChangeDetector = $__export("ProtoChangeDetector", (function() {
        var ProtoChangeDetector = function ProtoChangeDetector() {
          ;
        };
        return ($traceurRuntime.createClass)(ProtoChangeDetector, {
          addAst: function(ast, bindingMemento) {
            var directiveMemento = arguments[2] !== (void 0) ? arguments[2] : null;
          },
          instantiate: function(dispatcher, bindingRecords, variableBindings, directiveMemento) {
            return null;
          }
        }, {});
      }()));
      Object.defineProperty(ProtoChangeDetector.prototype.addAst, "parameters", {get: function() {
          return [[AST], [assert.type.any], [assert.type.any]];
        }});
      Object.defineProperty(ProtoChangeDetector.prototype.instantiate, "parameters", {get: function() {
          return [[assert.type.any], [List], [List], [List]];
        }});
      ChangeDetection = $__export("ChangeDetection", (function() {
        var ChangeDetection = function ChangeDetection() {
          ;
        };
        return ($traceurRuntime.createClass)(ChangeDetection, {createProtoChangeDetector: function(name, changeControlStrategy) {
            return null;
          }}, {});
      }()));
      Object.defineProperty(ChangeDetection.prototype.createProtoChangeDetector, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      ChangeRecord = $__export("ChangeRecord", (function() {
        var ChangeRecord = function ChangeRecord(bindingMemento, change) {
          this.bindingMemento = bindingMemento;
          this.change = change;
        };
        return ($traceurRuntime.createClass)(ChangeRecord, {
          get currentValue() {
            return this.change.currentValue;
          },
          get previousValue() {
            return this.change.previousValue;
          }
        }, {});
      }()));
      ChangeDispatcher = $__export("ChangeDispatcher", (function() {
        var ChangeDispatcher = function ChangeDispatcher() {
          ;
        };
        return ($traceurRuntime.createClass)(ChangeDispatcher, {onRecordChange: function(directiveMemento, records) {}}, {});
      }()));
      Object.defineProperty(ChangeDispatcher.prototype.onRecordChange, "parameters", {get: function() {
          return [[], [assert.genericType(List, ChangeRecord)]];
        }});
      ChangeDetector = $__export("ChangeDetector", (function() {
        var ChangeDetector = function ChangeDetector() {
          ;
        };
        return ($traceurRuntime.createClass)(ChangeDetector, {
          addChild: function(cd) {},
          removeChild: function(cd) {},
          remove: function() {},
          hydrate: function(context, locals) {},
          dehydrate: function() {},
          markPathToRootAsCheckOnce: function() {},
          detectChanges: function() {},
          checkNoChanges: function() {}
        }, {});
      }()));
      Object.defineProperty(ChangeDetector.prototype.addChild, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
      Object.defineProperty(ChangeDetector.prototype.removeChild, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
      Object.defineProperty(ChangeDetector.prototype.hydrate, "parameters", {get: function() {
          return [[assert.type.any], [Locals]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/constants", [], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/constants";
  var CHECK_ONCE,
      CHECKED,
      CHECK_ALWAYS,
      DETACHED,
      ON_PUSH,
      DEFAULT;
  return {
    setters: [],
    execute: function() {
      CHECK_ONCE = $__export("CHECK_ONCE", "CHECK_ONCE");
      CHECKED = $__export("CHECKED", "CHECKED");
      CHECK_ALWAYS = $__export("CHECK_ALWAYS", "ALWAYS_CHECK");
      DETACHED = $__export("DETACHED", "DETACHED");
      ON_PUSH = $__export("ON_PUSH", "ON_PUSH");
      DEFAULT = $__export("DEFAULT", "DEFAULT");
    }
  };
});

System.register("angular2/src/change_detection/pipes/pipe", [], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/pipes/pipe";
  var NO_CHANGE,
      Pipe;
  return {
    setters: [],
    execute: function() {
      NO_CHANGE = $__export("NO_CHANGE", new Object());
      Pipe = $__export("Pipe", (function() {
        var Pipe = function Pipe() {
          ;
        };
        return ($traceurRuntime.createClass)(Pipe, {
          supports: function(obj) {
            return false;
          },
          onDestroy: function() {},
          transform: function(value) {
            return null;
          }
        }, {});
      }()));
      Object.defineProperty(Pipe.prototype.transform, "parameters", {get: function() {
          return [[assert.type.any]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/binding_propagation_config", ["angular2/src/change_detection/interfaces", "angular2/src/change_detection/constants"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/binding_propagation_config";
  var ChangeDetector,
      CHECK_ONCE,
      DETACHED,
      CHECK_ALWAYS,
      BindingPropagationConfig;
  return {
    setters: [function($__m) {
      ChangeDetector = $__m.ChangeDetector;
    }, function($__m) {
      CHECK_ONCE = $__m.CHECK_ONCE;
      DETACHED = $__m.DETACHED;
      CHECK_ALWAYS = $__m.CHECK_ALWAYS;
    }],
    execute: function() {
      BindingPropagationConfig = $__export("BindingPropagationConfig", (function() {
        var BindingPropagationConfig = function BindingPropagationConfig(cd) {
          this._cd = cd;
        };
        return ($traceurRuntime.createClass)(BindingPropagationConfig, {
          shouldBePropagated: function() {
            this._cd.mode = CHECK_ONCE;
          },
          shouldBePropagatedFromRoot: function() {
            this._cd.markPathToRootAsCheckOnce();
          },
          shouldNotPropagate: function() {
            this._cd.mode = DETACHED;
          },
          shouldAlwaysPropagate: function() {
            this._cd.mode = CHECK_ALWAYS;
          }
        }, {});
      }()));
      Object.defineProperty(BindingPropagationConfig, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/pipes/pipe_registry", ["angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/change_detection/pipes/pipe", "angular2/src/change_detection/binding_propagation_config"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/pipes/pipe_registry";
  var List,
      ListWrapper,
      isBlank,
      isPresent,
      BaseException,
      CONST,
      Pipe,
      BindingPropagationConfig,
      PipeRegistry;
  return {
    setters: [function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      CONST = $__m.CONST;
    }, function($__m) {
      Pipe = $__m.Pipe;
    }, function($__m) {
      BindingPropagationConfig = $__m.BindingPropagationConfig;
    }],
    execute: function() {
      PipeRegistry = $__export("PipeRegistry", (function() {
        var PipeRegistry = function PipeRegistry(config) {
          this.config = config;
        };
        return ($traceurRuntime.createClass)(PipeRegistry, {get: function(type, obj, bpc) {
            var listOfConfigs = this.config[type];
            if (isBlank(listOfConfigs)) {
              throw new BaseException(("Cannot find a pipe for type '" + type + "' object '" + obj + "'"));
            }
            var matchingConfig = ListWrapper.find(listOfConfigs, (function(pipeConfig) {
              return pipeConfig.supports(obj);
            }));
            if (isBlank(matchingConfig)) {
              throw new BaseException(("Cannot find a pipe for type '" + type + "' object '" + obj + "'"));
            }
            return matchingConfig.create(bpc);
          }}, {});
      }()));
      Object.defineProperty(PipeRegistry.prototype.get, "parameters", {get: function() {
          return [[assert.type.string], [], [BindingPropagationConfig]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/change_detection_jit_generator", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/abstract_change_detector", "angular2/src/change_detection/change_detection_util", "angular2/src/change_detection/proto_record"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/change_detection_jit_generator";
  var isPresent,
      isBlank,
      BaseException,
      Type,
      List,
      ListWrapper,
      MapWrapper,
      StringMapWrapper,
      AbstractChangeDetector,
      ChangeDetectionUtil,
      ProtoRecord,
      RECORD_TYPE_SELF,
      RECORD_TYPE_PROPERTY,
      RECORD_TYPE_LOCAL,
      RECORD_TYPE_INVOKE_METHOD,
      RECORD_TYPE_CONST,
      RECORD_TYPE_INVOKE_CLOSURE,
      RECORD_TYPE_PRIMITIVE_OP,
      RECORD_TYPE_KEYED_ACCESS,
      RECORD_TYPE_PIPE,
      RECORD_TYPE_BINDING_PIPE,
      RECORD_TYPE_INTERPOLATE,
      ABSTRACT_CHANGE_DETECTOR,
      UTIL,
      DISPATCHER_ACCESSOR,
      PIPE_REGISTRY_ACCESSOR,
      PROTOS_ACCESSOR,
      MEMENTOS_ACCESSOR,
      CONTEXT_ACCESSOR,
      CHANGE_LOCAL,
      CHANGES_LOCAL,
      LOCALS_ACCESSOR,
      MODE_ACCESSOR,
      TEMP_LOCAL,
      ChangeDetectorJITGenerator;
  function typeTemplate(type, cons, detectChanges, notifyOnAllChangesDone, setContext) {
    return ("\n" + cons + "\n" + detectChanges + "\n" + notifyOnAllChangesDone + "\n" + setContext + ";\n\nreturn function(dispatcher, pipeRegistry) {\n  return new " + type + "(dispatcher, pipeRegistry, protos, directiveMementos);\n}\n");
  }
  function constructorTemplate(type, fieldsDefinitions) {
    return ("\nvar " + type + " = function " + type + "(dispatcher, pipeRegistry, protos, directiveMementos) {\n" + ABSTRACT_CHANGE_DETECTOR + ".call(this);\n" + DISPATCHER_ACCESSOR + " = dispatcher;\n" + PIPE_REGISTRY_ACCESSOR + " = pipeRegistry;\n" + PROTOS_ACCESSOR + " = protos;\n" + MEMENTOS_ACCESSOR + " = directiveMementos;\n" + fieldsDefinitions + "\n}\n\n" + type + ".prototype = Object.create(" + ABSTRACT_CHANGE_DETECTOR + ".prototype);\n");
  }
  function pipeOnDestroyTemplate(pipeNames) {
    return pipeNames.map((function(p) {
      return (p + ".onDestroy()");
    })).join("\n");
  }
  function hydrateTemplate(type, mode, fieldsDefinitions, pipeOnDestroy) {
    return ("\n" + type + ".prototype.hydrate = function(context, locals) {\n  " + MODE_ACCESSOR + " = \"" + mode + "\";\n  " + CONTEXT_ACCESSOR + " = context;\n  " + LOCALS_ACCESSOR + " = locals;\n}\n" + type + ".prototype.dehydrate = function() {\n  " + pipeOnDestroy + "\n  " + fieldsDefinitions + "\n  " + LOCALS_ACCESSOR + " = null;\n}\n" + type + ".prototype.hydrated = function() {\n  return " + CONTEXT_ACCESSOR + " !== " + UTIL + ".unitialized();\n}\n");
  }
  function detectChangesTemplate(type, body) {
    return ("\n" + type + ".prototype.detectChangesInRecords = function(throwOnChange) {\n  " + body + "\n}\n");
  }
  function callOnAllChangesDoneTemplate(type, body) {
    return ("\n" + type + ".prototype.callOnAllChangesDone = function() {\n  " + body + "\n}\n");
  }
  function onAllChangesDoneTemplate(index) {
    return (DISPATCHER_ACCESSOR + ".onAllChangesDone(" + MEMENTOS_ACCESSOR + "[" + index + "]);");
  }
  function bodyTemplate(localDefinitions, changeDefinitions, records) {
    return ("\n" + localDefinitions + "\n" + changeDefinitions + "\nvar " + TEMP_LOCAL + ";\nvar " + CHANGE_LOCAL + ";\nvar " + CHANGES_LOCAL + " = null;\n\ncontext = " + CONTEXT_ACCESSOR + ";\n" + records + "\n");
  }
  function notifyTemplate(index) {
    return ("\nif (" + CHANGES_LOCAL + " && " + CHANGES_LOCAL + ".length > 0) {\n  if(throwOnChange) " + UTIL + ".throwOnChange(" + PROTOS_ACCESSOR + "[" + index + "], " + CHANGES_LOCAL + "[0]);\n  " + DISPATCHER_ACCESSOR + ".onRecordChange(" + PROTOS_ACCESSOR + "[" + index + "].directiveMemento, " + CHANGES_LOCAL + ");\n  " + CHANGES_LOCAL + " = null;\n}\n");
  }
  function pipeCheckTemplate(context, bindingPropagationConfig, pipe, pipeType, value, change, addRecord, notify) {
    return ("\nif (" + pipe + " === " + UTIL + ".unitialized()) {\n  " + pipe + " = " + PIPE_REGISTRY_ACCESSOR + ".get('" + pipeType + "', " + context + ", " + bindingPropagationConfig + ");\n} else if (!" + pipe + ".supports(" + context + ")) {\n  " + pipe + ".onDestroy();\n  " + pipe + " = " + PIPE_REGISTRY_ACCESSOR + ".get('" + pipeType + "', " + context + ", " + bindingPropagationConfig + ");\n}\n\n" + CHANGE_LOCAL + " = " + pipe + ".transform(" + context + ");\nif (! " + UTIL + ".noChangeMarker(" + CHANGE_LOCAL + ")) {\n  " + value + " = " + CHANGE_LOCAL + ";\n  " + change + " = true;\n  " + addRecord + "\n}\n" + notify + "\n");
  }
  function referenceCheckTemplate(assignment, newValue, oldValue, change, addRecord, notify) {
    return ("\n" + assignment + "\nif (" + newValue + " !== " + oldValue + " || (" + newValue + " !== " + newValue + ") && (" + oldValue + " !== " + oldValue + ")) {\n  " + change + " = true;\n  " + addRecord + "\n  " + oldValue + " = " + newValue + ";\n}\n" + notify + "\n");
  }
  function assignmentTemplate(field, value) {
    return (field + " = " + value + ";");
  }
  function localDefinitionsTemplate(names) {
    return names.map((function(n) {
      return ("var " + n + ";");
    })).join("\n");
  }
  function changeDefinitionsTemplate(names) {
    return names.map((function(n) {
      return ("var " + n + " = false;");
    })).join("\n");
  }
  function fieldDefinitionsTemplate(names) {
    return names.map((function(n) {
      return (n + " = " + UTIL + ".unitialized();");
    })).join("\n");
  }
  function ifChangedGuardTemplate(changeNames, body) {
    var cond = changeNames.join(" || ");
    return ("\nif (" + cond + ") {\n  " + body + "\n}\n");
  }
  function addSimpleChangeRecordTemplate(protoIndex, oldValue, newValue) {
    return (CHANGES_LOCAL + " = " + UTIL + ".addRecord(" + CHANGES_LOCAL + ",\n    " + UTIL + ".simpleChangeRecord(" + PROTOS_ACCESSOR + "[" + protoIndex + "].bindingMemento, " + oldValue + ", " + newValue + "));");
  }
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      Type = $__m.Type;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      AbstractChangeDetector = $__m.AbstractChangeDetector;
    }, function($__m) {
      ChangeDetectionUtil = $__m.ChangeDetectionUtil;
    }, function($__m) {
      ProtoRecord = $__m.ProtoRecord;
      RECORD_TYPE_SELF = $__m.RECORD_TYPE_SELF;
      RECORD_TYPE_PROPERTY = $__m.RECORD_TYPE_PROPERTY;
      RECORD_TYPE_LOCAL = $__m.RECORD_TYPE_LOCAL;
      RECORD_TYPE_INVOKE_METHOD = $__m.RECORD_TYPE_INVOKE_METHOD;
      RECORD_TYPE_CONST = $__m.RECORD_TYPE_CONST;
      RECORD_TYPE_INVOKE_CLOSURE = $__m.RECORD_TYPE_INVOKE_CLOSURE;
      RECORD_TYPE_PRIMITIVE_OP = $__m.RECORD_TYPE_PRIMITIVE_OP;
      RECORD_TYPE_KEYED_ACCESS = $__m.RECORD_TYPE_KEYED_ACCESS;
      RECORD_TYPE_PIPE = $__m.RECORD_TYPE_PIPE;
      RECORD_TYPE_BINDING_PIPE = $__m.RECORD_TYPE_BINDING_PIPE;
      RECORD_TYPE_INTERPOLATE = $__m.RECORD_TYPE_INTERPOLATE;
    }],
    execute: function() {
      ABSTRACT_CHANGE_DETECTOR = "AbstractChangeDetector";
      UTIL = "ChangeDetectionUtil";
      DISPATCHER_ACCESSOR = "this.dispatcher";
      PIPE_REGISTRY_ACCESSOR = "this.pipeRegistry";
      PROTOS_ACCESSOR = "this.protos";
      MEMENTOS_ACCESSOR = "this.directiveMementos";
      CONTEXT_ACCESSOR = "this.context";
      CHANGE_LOCAL = "change";
      CHANGES_LOCAL = "changes";
      LOCALS_ACCESSOR = "this.locals";
      MODE_ACCESSOR = "this.mode";
      TEMP_LOCAL = "temp";
      Object.defineProperty(typeTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(constructorTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(pipeOnDestroyTemplate, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(hydrateTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(detectChangesTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(callOnAllChangesDoneTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(onAllChangesDoneTemplate, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(bodyTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(notifyTemplate, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(pipeCheckTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(assignmentTemplate, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(localDefinitionsTemplate, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(changeDefinitionsTemplate, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(fieldDefinitionsTemplate, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(ifChangedGuardTemplate, "parameters", {get: function() {
          return [[List], [assert.type.string]];
        }});
      Object.defineProperty(addSimpleChangeRecordTemplate, "parameters", {get: function() {
          return [[assert.type.number], [assert.type.string], [assert.type.string]];
        }});
      ChangeDetectorJITGenerator = $__export("ChangeDetectorJITGenerator", (function() {
        var ChangeDetectorJITGenerator = function ChangeDetectorJITGenerator(typeName, changeDetectionStrategy, records, directiveMementos) {
          this.typeName = typeName;
          this.changeDetectionStrategy = changeDetectionStrategy;
          this.records = records;
          this.directiveMementos = directiveMementos;
          this.localNames = this.getLocalNames(records);
          this.changeNames = this.getChangeNames(this.localNames);
          this.fieldNames = this.getFieldNames(this.localNames);
          this.pipeNames = this.getPipeNames(this.localNames);
        };
        return ($traceurRuntime.createClass)(ChangeDetectorJITGenerator, {
          getLocalNames: function(records) {
            var index = 0;
            var names = records.map((function(r) {
              var sanitizedName = r.name.replace(new RegExp("\\W", "g"), '');
              return ("" + sanitizedName + index++);
            }));
            return ["context"].concat(names);
          },
          getChangeNames: function(localNames) {
            return localNames.map((function(n) {
              return ("change_" + n);
            }));
          },
          getFieldNames: function(localNames) {
            return localNames.map((function(n) {
              return ("this." + n);
            }));
          },
          getPipeNames: function(localNames) {
            return localNames.map((function(n) {
              return ("this." + n + "_pipe");
            }));
          },
          generate: function() {
            var text = typeTemplate(this.typeName, this.genConstructor(), this.genDetectChanges(), this.genCallOnAllChangesDone(), this.genHydrate());
            return new Function('AbstractChangeDetector', 'ChangeDetectionUtil', 'protos', 'directiveMementos', text)(AbstractChangeDetector, ChangeDetectionUtil, this.records, this.directiveMementos);
          },
          genConstructor: function() {
            return constructorTemplate(this.typeName, this.genFieldDefinitions());
          },
          genHydrate: function() {
            var mode = ChangeDetectionUtil.changeDetectionMode(this.changeDetectionStrategy);
            return hydrateTemplate(this.typeName, mode, this.genFieldDefinitions(), pipeOnDestroyTemplate(this.getNonNullPipeNames()));
          },
          genFieldDefinitions: function() {
            var fields = [];
            fields = fields.concat(this.fieldNames);
            fields = fields.concat(this.getNonNullPipeNames());
            return fieldDefinitionsTemplate(fields);
          },
          getNonNullPipeNames: function() {
            var $__0 = this;
            var pipes = [];
            this.records.forEach((function(r) {
              if (r.mode === RECORD_TYPE_PIPE || r.mode === RECORD_TYPE_BINDING_PIPE) {
                pipes.push($__0.pipeNames[r.selfIndex]);
              }
            }));
            return pipes;
          },
          genDetectChanges: function() {
            var body = this.genBody();
            return detectChangesTemplate(this.typeName, body);
          },
          genCallOnAllChangesDone: function() {
            var notifications = [];
            var mementos = this.directiveMementos;
            for (var i = mementos.length - 1; i >= 0; --i) {
              var memento = mementos[i];
              if (memento.callOnAllChangesDone) {
                notifications.push(onAllChangesDoneTemplate(i));
              }
            }
            return callOnAllChangesDoneTemplate(this.typeName, notifications.join(";\n"));
          },
          genBody: function() {
            var $__0 = this;
            var rec = this.records.map((function(r) {
              return $__0.genRecord(r);
            })).join("\n");
            return bodyTemplate(this.genLocalDefinitions(), this.genChangeDefinitions(), rec);
          },
          genLocalDefinitions: function() {
            return localDefinitionsTemplate(this.localNames);
          },
          genChangeDefinitions: function() {
            return changeDefinitionsTemplate(this.changeNames);
          },
          genRecord: function(r) {
            if (r.mode === RECORD_TYPE_PIPE || r.mode === RECORD_TYPE_BINDING_PIPE) {
              return this.genPipeCheck(r);
            } else {
              return this.genReferenceCheck(r);
            }
          },
          genPipeCheck: function(r) {
            var context = this.localNames[r.contextIndex];
            var pipe = this.pipeNames[r.selfIndex];
            var newValue = this.localNames[r.selfIndex];
            var oldValue = this.fieldNames[r.selfIndex];
            var change = this.changeNames[r.selfIndex];
            var bpc = r.mode === RECORD_TYPE_BINDING_PIPE ? "this.bindingPropagationConfig" : "null";
            var addRecord = addSimpleChangeRecordTemplate(r.selfIndex - 1, oldValue, newValue);
            var notify = this.genNotify(r);
            return pipeCheckTemplate(context, bpc, pipe, r.name, newValue, change, addRecord, notify);
          },
          genReferenceCheck: function(r) {
            var newValue = this.localNames[r.selfIndex];
            var oldValue = this.fieldNames[r.selfIndex];
            var change = this.changeNames[r.selfIndex];
            var assignment = this.genUpdateCurrentValue(r);
            var addRecord = addSimpleChangeRecordTemplate(r.selfIndex - 1, oldValue, newValue);
            var notify = this.genNotify(r);
            var check = referenceCheckTemplate(assignment, newValue, oldValue, change, r.lastInBinding ? addRecord : '', notify);
            if (r.isPureFunction()) {
              return this.ifChangedGuard(r, check);
            } else {
              return check;
            }
          },
          genUpdateCurrentValue: function(r) {
            var context = this.localNames[r.contextIndex];
            var newValue = this.localNames[r.selfIndex];
            var args = this.genArgs(r);
            switch (r.mode) {
              case RECORD_TYPE_SELF:
                return assignmentTemplate(newValue, context);
              case RECORD_TYPE_CONST:
                return (newValue + " = " + this.genLiteral(r.funcOrValue));
              case RECORD_TYPE_PROPERTY:
                return assignmentTemplate(newValue, (context + "." + r.name));
              case RECORD_TYPE_LOCAL:
                return assignmentTemplate(newValue, (LOCALS_ACCESSOR + ".get('" + r.name + "')"));
              case RECORD_TYPE_INVOKE_METHOD:
                return assignmentTemplate(newValue, (context + "." + r.name + "(" + args + ")"));
              case RECORD_TYPE_INVOKE_CLOSURE:
                return assignmentTemplate(newValue, (context + "(" + args + ")"));
              case RECORD_TYPE_PRIMITIVE_OP:
                return assignmentTemplate(newValue, (UTIL + "." + r.name + "(" + args + ")"));
              case RECORD_TYPE_INTERPOLATE:
                return assignmentTemplate(newValue, this.genInterpolation(r));
              case RECORD_TYPE_KEYED_ACCESS:
                var key = this.localNames[r.args[0]];
                return assignmentTemplate(newValue, (context + "[" + key + "]"));
              default:
                throw new BaseException(("Unknown operation " + r.mode));
            }
          },
          ifChangedGuard: function(r, body) {
            var $__0 = this;
            return ifChangedGuardTemplate(r.args.map((function(a) {
              return $__0.changeNames[a];
            })), body);
          },
          genInterpolation: function(r) {
            var res = "";
            for (var i = 0; i < r.args.length; ++i) {
              res += this.genLiteral(r.fixedArgs[i]);
              res += " + ";
              res += this.localNames[r.args[i]];
              res += " + ";
            }
            res += this.genLiteral(r.fixedArgs[r.args.length]);
            return res;
          },
          genLiteral: function(value) {
            return JSON.stringify(value);
          },
          genNotify: function(r) {
            return r.lastInDirective ? notifyTemplate(r.selfIndex - 1) : '';
          },
          genArgs: function(r) {
            var $__0 = this;
            return r.args.map((function(arg) {
              return $__0.localNames[arg];
            })).join(", ");
          }
        }, {});
      }()));
      Object.defineProperty(ChangeDetectorJITGenerator, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.genericType(List, ProtoRecord)], [List]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.getLocalNames, "parameters", {get: function() {
          return [[assert.genericType(List, ProtoRecord)]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.getChangeNames, "parameters", {get: function() {
          return [[assert.genericType(List, assert.type.string)]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.getFieldNames, "parameters", {get: function() {
          return [[assert.genericType(List, assert.type.string)]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.getPipeNames, "parameters", {get: function() {
          return [[assert.genericType(List, assert.type.string)]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genRecord, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genPipeCheck, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genReferenceCheck, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genUpdateCurrentValue, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.ifChangedGuard, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.string]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genInterpolation, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(ChangeDetectorJITGenerator.prototype.genArgs, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/coalesce", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/proto_record"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/coalesce";
  var isPresent,
      List,
      ListWrapper,
      Map,
      MapWrapper,
      RECORD_TYPE_SELF,
      ProtoRecord;
  function coalesce(records) {
    var res = ListWrapper.create();
    var indexMap = MapWrapper.create();
    for (var i = 0; i < records.length; ++i) {
      var r = records[i];
      var record = _replaceIndices(r, res.length + 1, indexMap);
      var matchingRecord = _findMatching(record, res);
      if (isPresent(matchingRecord) && record.lastInBinding) {
        ListWrapper.push(res, _selfRecord(record, matchingRecord.selfIndex, res.length + 1));
        MapWrapper.set(indexMap, r.selfIndex, matchingRecord.selfIndex);
      } else if (isPresent(matchingRecord) && !record.lastInBinding) {
        MapWrapper.set(indexMap, r.selfIndex, matchingRecord.selfIndex);
      } else {
        ListWrapper.push(res, record);
        MapWrapper.set(indexMap, r.selfIndex, record.selfIndex);
      }
    }
    return res;
  }
  function _selfRecord(r, contextIndex, selfIndex) {
    return new ProtoRecord(RECORD_TYPE_SELF, "self", null, [], r.fixedArgs, contextIndex, selfIndex, r.bindingMemento, r.directiveMemento, r.expressionAsString, r.lastInBinding, r.lastInDirective);
  }
  function _findMatching(r, rs) {
    return ListWrapper.find(rs, (function(rr) {
      return rr.mode === r.mode && rr.funcOrValue === r.funcOrValue && rr.contextIndex === r.contextIndex && ListWrapper.equals(rr.args, r.args);
    }));
  }
  function _replaceIndices(r, selfIndex, indexMap) {
    var args = ListWrapper.map(r.args, (function(a) {
      return _map(indexMap, a);
    }));
    var contextIndex = _map(indexMap, r.contextIndex);
    return new ProtoRecord(r.mode, r.name, r.funcOrValue, args, r.fixedArgs, contextIndex, selfIndex, r.bindingMemento, r.directiveMemento, r.expressionAsString, r.lastInBinding, r.lastInDirective);
  }
  function _map(indexMap, value) {
    var r = MapWrapper.get(indexMap, value);
    return isPresent(r) ? r : value;
  }
  $__export("coalesce", coalesce);
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      RECORD_TYPE_SELF = $__m.RECORD_TYPE_SELF;
      ProtoRecord = $__m.ProtoRecord;
    }],
    execute: function() {
      Object.defineProperty(coalesce, "parameters", {get: function() {
          return [[assert.genericType(List, ProtoRecord)]];
        }});
      Object.defineProperty(_selfRecord, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.number], [assert.type.number]];
        }});
      Object.defineProperty(_findMatching, "parameters", {get: function() {
          return [[ProtoRecord], [assert.genericType(List, ProtoRecord)]];
        }});
      Object.defineProperty(_replaceIndices, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.number], [Map]];
        }});
      Object.defineProperty(_map, "parameters", {get: function() {
          return [[Map], [assert.type.number]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/pipes/iterable_changes", ["angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/change_detection/pipes/pipe"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/pipes/iterable_changes";
  var isListLikeIterable,
      iterateListLike,
      ListWrapper,
      MapWrapper,
      int,
      isBlank,
      isPresent,
      stringify,
      getMapKey,
      looseIdentical,
      NO_CHANGE,
      Pipe,
      IterableChangesFactory,
      IterableChanges,
      CollectionChangeRecord,
      _DuplicateItemRecordList,
      _DuplicateMap;
  return {
    setters: [function($__m) {
      isListLikeIterable = $__m.isListLikeIterable;
      iterateListLike = $__m.iterateListLike;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      int = $__m.int;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      stringify = $__m.stringify;
      getMapKey = $__m.getMapKey;
      looseIdentical = $__m.looseIdentical;
    }, function($__m) {
      NO_CHANGE = $__m.NO_CHANGE;
      Pipe = $__m.Pipe;
    }],
    execute: function() {
      IterableChangesFactory = $__export("IterableChangesFactory", (function() {
        var IterableChangesFactory = function IterableChangesFactory() {
          ;
        };
        return ($traceurRuntime.createClass)(IterableChangesFactory, {
          supports: function(obj) {
            return IterableChanges.supportsObj(obj);
          },
          create: function(bpc) {
            return new IterableChanges();
          }
        }, {});
      }()));
      IterableChanges = $__export("IterableChanges", (function($__super) {
        var IterableChanges = function IterableChanges() {
          $traceurRuntime.superConstructor(IterableChanges).call(this);
          this._collection = null;
          this._length = null;
          this._linkedRecords = null;
          this._unlinkedRecords = null;
          this._previousItHead = null;
          this._itHead = null;
          this._itTail = null;
          this._additionsHead = null;
          this._additionsTail = null;
          this._movesHead = null;
          this._movesTail = null;
          this._removalsHead = null;
          this._removalsTail = null;
        };
        return ($traceurRuntime.createClass)(IterableChanges, {
          supports: function(obj) {
            return IterableChanges.supportsObj(obj);
          },
          get collection() {
            return this._collection;
          },
          get length() {
            return this._length;
          },
          forEachItem: function(fn) {
            var record;
            for (record = this._itHead; record !== null; record = record._next) {
              fn(record);
            }
          },
          forEachPreviousItem: function(fn) {
            var record;
            for (record = this._previousItHead; record !== null; record = record._nextPrevious) {
              fn(record);
            }
          },
          forEachAddedItem: function(fn) {
            var record;
            for (record = this._additionsHead; record !== null; record = record._nextAdded) {
              fn(record);
            }
          },
          forEachMovedItem: function(fn) {
            var record;
            for (record = this._movesHead; record !== null; record = record._nextMoved) {
              fn(record);
            }
          },
          forEachRemovedItem: function(fn) {
            var record;
            for (record = this._removalsHead; record !== null; record = record._nextRemoved) {
              fn(record);
            }
          },
          transform: function(collection) {
            if (this.check(collection)) {
              return this;
            } else {
              return NO_CHANGE;
            }
          },
          check: function(collection) {
            var $__0 = this;
            this._reset();
            var record = this._itHead;
            var mayBeDirty = false;
            var index;
            var item;
            if (ListWrapper.isList(collection)) {
              var list = collection;
              this._length = collection.length;
              for (index = 0; index < this._length; index++) {
                item = list[index];
                if (record === null || !looseIdentical(record.item, item)) {
                  record = this._mismatch(record, item, index);
                  mayBeDirty = true;
                } else if (mayBeDirty) {
                  record = this._verifyReinsertion(record, item, index);
                }
                record = record._next;
              }
            } else {
              index = 0;
              iterateListLike(collection, (function(item) {
                if (record === null || !looseIdentical(record.item, item)) {
                  record = $__0._mismatch(record, item, index);
                  mayBeDirty = true;
                } else if (mayBeDirty) {
                  record = $__0._verifyReinsertion(record, item, index);
                }
                record = record._next;
                index++;
              }));
              this._length = index;
            }
            this._truncate(record);
            this._collection = collection;
            return this.isDirty;
          },
          get isDirty() {
            return this._additionsHead !== null || this._movesHead !== null || this._removalsHead !== null;
          },
          _reset: function() {
            if (this.isDirty) {
              var record;
              var nextRecord;
              for (record = this._previousItHead = this._itHead; record !== null; record = record._next) {
                record._nextPrevious = record._next;
              }
              for (record = this._additionsHead; record !== null; record = record._nextAdded) {
                record.previousIndex = record.currentIndex;
              }
              this._additionsHead = this._additionsTail = null;
              for (record = this._movesHead; record !== null; record = nextRecord) {
                record.previousIndex = record.currentIndex;
                nextRecord = record._nextMoved;
              }
              this._movesHead = this._movesTail = null;
              this._removalsHead = this._removalsTail = null;
            }
          },
          _mismatch: function(record, item, index) {
            var previousRecord;
            if (record === null) {
              previousRecord = this._itTail;
            } else {
              previousRecord = record._prev;
              this._remove(record);
            }
            record = this._linkedRecords === null ? null : this._linkedRecords.get(item, index);
            if (record !== null) {
              this._moveAfter(record, previousRecord, index);
            } else {
              record = this._unlinkedRecords === null ? null : this._unlinkedRecords.get(item);
              if (record !== null) {
                this._reinsertAfter(record, previousRecord, index);
              } else {
                record = this._addAfter(new CollectionChangeRecord(item), previousRecord, index);
              }
            }
            return record;
          },
          _verifyReinsertion: function(record, item, index) {
            var reinsertRecord = this._unlinkedRecords === null ? null : this._unlinkedRecords.get(item);
            if (reinsertRecord !== null) {
              record = this._reinsertAfter(reinsertRecord, record._prev, index);
            } else if (record.currentIndex != index) {
              record.currentIndex = index;
              this._addToMoves(record, index);
            }
            return record;
          },
          _truncate: function(record) {
            while (record !== null) {
              var nextRecord = record._next;
              this._addToRemovals(this._unlink(record));
              record = nextRecord;
            }
            if (this._unlinkedRecords !== null) {
              this._unlinkedRecords.clear();
            }
            if (this._additionsTail !== null) {
              this._additionsTail._nextAdded = null;
            }
            if (this._movesTail !== null) {
              this._movesTail._nextMoved = null;
            }
            if (this._itTail !== null) {
              this._itTail._next = null;
            }
            if (this._removalsTail !== null) {
              this._removalsTail._nextRemoved = null;
            }
          },
          _reinsertAfter: function(record, prevRecord, index) {
            if (this._unlinkedRecords !== null) {
              this._unlinkedRecords.remove(record);
            }
            var prev = record._prevRemoved;
            var next = record._nextRemoved;
            if (prev === null) {
              this._removalsHead = next;
            } else {
              prev._nextRemoved = next;
            }
            if (next === null) {
              this._removalsTail = prev;
            } else {
              next._prevRemoved = prev;
            }
            this._insertAfter(record, prevRecord, index);
            this._addToMoves(record, index);
            return record;
          },
          _moveAfter: function(record, prevRecord, index) {
            this._unlink(record);
            this._insertAfter(record, prevRecord, index);
            this._addToMoves(record, index);
            return record;
          },
          _addAfter: function(record, prevRecord, index) {
            this._insertAfter(record, prevRecord, index);
            if (this._additionsTail === null) {
              this._additionsTail = this._additionsHead = record;
            } else {
              this._additionsTail = this._additionsTail._nextAdded = record;
            }
            return record;
          },
          _insertAfter: function(record, prevRecord, index) {
            var next = prevRecord === null ? this._itHead : prevRecord._next;
            record._next = next;
            record._prev = prevRecord;
            if (next === null) {
              this._itTail = record;
            } else {
              next._prev = record;
            }
            if (prevRecord === null) {
              this._itHead = record;
            } else {
              prevRecord._next = record;
            }
            if (this._linkedRecords === null) {
              this._linkedRecords = new _DuplicateMap();
            }
            this._linkedRecords.put(record);
            record.currentIndex = index;
            return record;
          },
          _remove: function(record) {
            return this._addToRemovals(this._unlink(record));
          },
          _unlink: function(record) {
            if (this._linkedRecords !== null) {
              this._linkedRecords.remove(record);
            }
            var prev = record._prev;
            var next = record._next;
            if (prev === null) {
              this._itHead = next;
            } else {
              prev._next = next;
            }
            if (next === null) {
              this._itTail = prev;
            } else {
              next._prev = prev;
            }
            return record;
          },
          _addToMoves: function(record, toIndex) {
            if (record.previousIndex === toIndex) {
              return record;
            }
            if (this._movesTail === null) {
              this._movesTail = this._movesHead = record;
            } else {
              this._movesTail = this._movesTail._nextMoved = record;
            }
            return record;
          },
          _addToRemovals: function(record) {
            if (this._unlinkedRecords === null) {
              this._unlinkedRecords = new _DuplicateMap();
            }
            this._unlinkedRecords.put(record);
            record.currentIndex = null;
            record._nextRemoved = null;
            if (this._removalsTail === null) {
              this._removalsTail = this._removalsHead = record;
              record._prevRemoved = null;
            } else {
              record._prevRemoved = this._removalsTail;
              this._removalsTail = this._removalsTail._nextRemoved = record;
            }
            return record;
          },
          toString: function() {
            var record;
            var list = [];
            for (record = this._itHead; record !== null; record = record._next) {
              ListWrapper.push(list, record);
            }
            var previous = [];
            for (record = this._previousItHead; record !== null; record = record._nextPrevious) {
              ListWrapper.push(previous, record);
            }
            var additions = [];
            for (record = this._additionsHead; record !== null; record = record._nextAdded) {
              ListWrapper.push(additions, record);
            }
            var moves = [];
            for (record = this._movesHead; record !== null; record = record._nextMoved) {
              ListWrapper.push(moves, record);
            }
            var removals = [];
            for (record = this._removalsHead; record !== null; record = record._nextRemoved) {
              ListWrapper.push(removals, record);
            }
            return "collection: " + list.join(', ') + "\n" + "previous: " + previous.join(', ') + "\n" + "additions: " + additions.join(', ') + "\n" + "moves: " + moves.join(', ') + "\n" + "removals: " + removals.join(', ') + "\n";
          }
        }, {supportsObj: function(obj) {
            return isListLikeIterable(obj);
          }}, $__super);
      }(Pipe)));
      Object.defineProperty(IterableChanges.prototype.forEachItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(IterableChanges.prototype.forEachPreviousItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(IterableChanges.prototype.forEachAddedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(IterableChanges.prototype.forEachMovedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(IterableChanges.prototype.forEachRemovedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(IterableChanges.prototype._mismatch, "parameters", {get: function() {
          return [[CollectionChangeRecord], [], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._verifyReinsertion, "parameters", {get: function() {
          return [[CollectionChangeRecord], [], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._truncate, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      Object.defineProperty(IterableChanges.prototype._reinsertAfter, "parameters", {get: function() {
          return [[CollectionChangeRecord], [CollectionChangeRecord], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._moveAfter, "parameters", {get: function() {
          return [[CollectionChangeRecord], [CollectionChangeRecord], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._addAfter, "parameters", {get: function() {
          return [[CollectionChangeRecord], [CollectionChangeRecord], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._insertAfter, "parameters", {get: function() {
          return [[CollectionChangeRecord], [CollectionChangeRecord], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._remove, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      Object.defineProperty(IterableChanges.prototype._unlink, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      Object.defineProperty(IterableChanges.prototype._addToMoves, "parameters", {get: function() {
          return [[CollectionChangeRecord], [int]];
        }});
      Object.defineProperty(IterableChanges.prototype._addToRemovals, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      CollectionChangeRecord = $__export("CollectionChangeRecord", (function() {
        var CollectionChangeRecord = function CollectionChangeRecord(item) {
          this.currentIndex = null;
          this.previousIndex = null;
          this.item = item;
          this._nextPrevious = null;
          this._prev = null;
          this._next = null;
          this._prevDup = null;
          this._nextDup = null;
          this._prevRemoved = null;
          this._nextRemoved = null;
          this._nextAdded = null;
          this._nextMoved = null;
        };
        return ($traceurRuntime.createClass)(CollectionChangeRecord, {toString: function() {
            return this.previousIndex === this.currentIndex ? stringify(this.item) : stringify(this.item) + '[' + stringify(this.previousIndex) + '->' + stringify(this.currentIndex) + ']';
          }}, {});
      }()));
      _DuplicateItemRecordList = (function() {
        var _DuplicateItemRecordList = function _DuplicateItemRecordList() {
          this._head = null;
          this._tail = null;
        };
        return ($traceurRuntime.createClass)(_DuplicateItemRecordList, {
          add: function(record) {
            if (this._head === null) {
              this._head = this._tail = record;
              record._nextDup = null;
              record._prevDup = null;
            } else {
              this._tail._nextDup = record;
              record._prevDup = this._tail;
              record._nextDup = null;
              this._tail = record;
            }
          },
          get: function(item, afterIndex) {
            var record;
            for (record = this._head; record !== null; record = record._nextDup) {
              if ((afterIndex === null || afterIndex < record.currentIndex) && looseIdentical(record.item, item)) {
                return record;
              }
            }
            return null;
          },
          remove: function(record) {
            var prev = record._prevDup;
            var next = record._nextDup;
            if (prev === null) {
              this._head = next;
            } else {
              prev._nextDup = next;
            }
            if (next === null) {
              this._tail = prev;
            } else {
              next._prevDup = prev;
            }
            return this._head === null;
          }
        }, {});
      }());
      Object.defineProperty(_DuplicateItemRecordList.prototype.add, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      Object.defineProperty(_DuplicateItemRecordList.prototype.get, "parameters", {get: function() {
          return [[], [int]];
        }});
      Object.defineProperty(_DuplicateItemRecordList.prototype.remove, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      _DuplicateMap = (function() {
        var _DuplicateMap = function _DuplicateMap() {
          this.map = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(_DuplicateMap, {
          put: function(record) {
            var key = getMapKey(record.item);
            var duplicates = MapWrapper.get(this.map, key);
            if (!isPresent(duplicates)) {
              duplicates = new _DuplicateItemRecordList();
              MapWrapper.set(this.map, key, duplicates);
            }
            duplicates.add(record);
          },
          get: function(value) {
            var afterIndex = arguments[1] !== (void 0) ? arguments[1] : null;
            var key = getMapKey(value);
            var recordList = MapWrapper.get(this.map, key);
            return isBlank(recordList) ? null : recordList.get(value, afterIndex);
          },
          remove: function(record) {
            var key = getMapKey(record.item);
            var recordList = MapWrapper.get(this.map, key);
            if (recordList.remove(record)) {
              MapWrapper.delete(this.map, key);
            }
            return record;
          },
          get isEmpty() {
            return MapWrapper.size(this.map) === 0;
          },
          clear: function() {
            MapWrapper.clear(this.map);
          },
          toString: function() {
            return '_DuplicateMap(' + stringify(this.map) + ')';
          }
        }, {});
      }());
      Object.defineProperty(_DuplicateMap.prototype.put, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
      Object.defineProperty(_DuplicateMap.prototype.remove, "parameters", {get: function() {
          return [[CollectionChangeRecord]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/pipes/keyvalue_changes", ["angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/change_detection/pipes/pipe"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/pipes/keyvalue_changes";
  var ListWrapper,
      MapWrapper,
      StringMapWrapper,
      stringify,
      looseIdentical,
      isJsObject,
      NO_CHANGE,
      Pipe,
      KeyValueChangesFactory,
      KeyValueChanges,
      KVChangeRecord;
  return {
    setters: [function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      stringify = $__m.stringify;
      looseIdentical = $__m.looseIdentical;
      isJsObject = $__m.isJsObject;
    }, function($__m) {
      NO_CHANGE = $__m.NO_CHANGE;
      Pipe = $__m.Pipe;
    }],
    execute: function() {
      KeyValueChangesFactory = $__export("KeyValueChangesFactory", (function() {
        var KeyValueChangesFactory = function KeyValueChangesFactory() {
          ;
        };
        return ($traceurRuntime.createClass)(KeyValueChangesFactory, {
          supports: function(obj) {
            return KeyValueChanges.supportsObj(obj);
          },
          create: function(bpc) {
            return new KeyValueChanges();
          }
        }, {});
      }()));
      KeyValueChanges = $__export("KeyValueChanges", (function($__super) {
        var KeyValueChanges = function KeyValueChanges() {
          $traceurRuntime.superConstructor(KeyValueChanges).call(this);
          this._records = MapWrapper.create();
          this._mapHead = null;
          this._previousMapHead = null;
          this._changesHead = null;
          this._changesTail = null;
          this._additionsHead = null;
          this._additionsTail = null;
          this._removalsHead = null;
          this._removalsTail = null;
        };
        return ($traceurRuntime.createClass)(KeyValueChanges, {
          supports: function(obj) {
            return KeyValueChanges.supportsObj(obj);
          },
          transform: function(map) {
            if (this.check(map)) {
              return this;
            } else {
              return NO_CHANGE;
            }
          },
          get isDirty() {
            return this._additionsHead !== null || this._changesHead !== null || this._removalsHead !== null;
          },
          forEachItem: function(fn) {
            var record;
            for (record = this._mapHead; record !== null; record = record._next) {
              fn(record);
            }
          },
          forEachPreviousItem: function(fn) {
            var record;
            for (record = this._previousMapHead; record !== null; record = record._nextPrevious) {
              fn(record);
            }
          },
          forEachChangedItem: function(fn) {
            var record;
            for (record = this._changesHead; record !== null; record = record._nextChanged) {
              fn(record);
            }
          },
          forEachAddedItem: function(fn) {
            var record;
            for (record = this._additionsHead; record !== null; record = record._nextAdded) {
              fn(record);
            }
          },
          forEachRemovedItem: function(fn) {
            var record;
            for (record = this._removalsHead; record !== null; record = record._nextRemoved) {
              fn(record);
            }
          },
          check: function(map) {
            var $__0 = this;
            this._reset();
            var records = this._records;
            var oldSeqRecord = this._mapHead;
            var lastOldSeqRecord = null;
            var lastNewSeqRecord = null;
            var seqChanged = false;
            this._forEach(map, (function(value, key) {
              var newSeqRecord;
              if (oldSeqRecord !== null && key === oldSeqRecord.key) {
                newSeqRecord = oldSeqRecord;
                if (!looseIdentical(value, oldSeqRecord.currentValue)) {
                  oldSeqRecord.previousValue = oldSeqRecord.currentValue;
                  oldSeqRecord.currentValue = value;
                  $__0._addToChanges(oldSeqRecord);
                }
              } else {
                seqChanged = true;
                if (oldSeqRecord !== null) {
                  oldSeqRecord._next = null;
                  $__0._removeFromSeq(lastOldSeqRecord, oldSeqRecord);
                  $__0._addToRemovals(oldSeqRecord);
                }
                if (MapWrapper.contains(records, key)) {
                  newSeqRecord = MapWrapper.get(records, key);
                } else {
                  newSeqRecord = new KVChangeRecord(key);
                  MapWrapper.set(records, key, newSeqRecord);
                  newSeqRecord.currentValue = value;
                  $__0._addToAdditions(newSeqRecord);
                }
              }
              if (seqChanged) {
                if ($__0._isInRemovals(newSeqRecord)) {
                  $__0._removeFromRemovals(newSeqRecord);
                }
                if (lastNewSeqRecord == null) {
                  $__0._mapHead = newSeqRecord;
                } else {
                  lastNewSeqRecord._next = newSeqRecord;
                }
              }
              lastOldSeqRecord = oldSeqRecord;
              lastNewSeqRecord = newSeqRecord;
              oldSeqRecord = oldSeqRecord === null ? null : oldSeqRecord._next;
            }));
            this._truncate(lastOldSeqRecord, oldSeqRecord);
            return this.isDirty;
          },
          _reset: function() {
            if (this.isDirty) {
              var record;
              for (record = this._previousMapHead = this._mapHead; record !== null; record = record._next) {
                record._nextPrevious = record._next;
              }
              for (record = this._changesHead; record !== null; record = record._nextChanged) {
                record.previousValue = record.currentValue;
              }
              for (record = this._additionsHead; record != null; record = record._nextAdded) {
                record.previousValue = record.currentValue;
              }
              this._changesHead = this._changesTail = null;
              this._additionsHead = this._additionsTail = null;
              this._removalsHead = this._removalsTail = null;
            }
          },
          _truncate: function(lastRecord, record) {
            while (record !== null) {
              if (lastRecord === null) {
                this._mapHead = null;
              } else {
                lastRecord._next = null;
              }
              var nextRecord = record._next;
              this._addToRemovals(record);
              lastRecord = record;
              record = nextRecord;
            }
            for (var rec = this._removalsHead; rec !== null; rec = rec._nextRemoved) {
              rec.previousValue = rec.currentValue;
              rec.currentValue = null;
              MapWrapper.delete(this._records, rec.key);
            }
          },
          _isInRemovals: function(record) {
            return record === this._removalsHead || record._nextRemoved !== null || record._prevRemoved !== null;
          },
          _addToRemovals: function(record) {
            if (this._removalsHead === null) {
              this._removalsHead = this._removalsTail = record;
            } else {
              this._removalsTail._nextRemoved = record;
              record._prevRemoved = this._removalsTail;
              this._removalsTail = record;
            }
          },
          _removeFromSeq: function(prev, record) {
            var next = record._next;
            if (prev === null) {
              this._mapHead = next;
            } else {
              prev._next = next;
            }
          },
          _removeFromRemovals: function(record) {
            var prev = record._prevRemoved;
            var next = record._nextRemoved;
            if (prev === null) {
              this._removalsHead = next;
            } else {
              prev._nextRemoved = next;
            }
            if (next === null) {
              this._removalsTail = prev;
            } else {
              next._prevRemoved = prev;
            }
            record._prevRemoved = record._nextRemoved = null;
          },
          _addToAdditions: function(record) {
            if (this._additionsHead === null) {
              this._additionsHead = this._additionsTail = record;
            } else {
              this._additionsTail._nextAdded = record;
              this._additionsTail = record;
            }
          },
          _addToChanges: function(record) {
            if (this._changesHead === null) {
              this._changesHead = this._changesTail = record;
            } else {
              this._changesTail._nextChanged = record;
              this._changesTail = record;
            }
          },
          toString: function() {
            var items = [];
            var previous = [];
            var changes = [];
            var additions = [];
            var removals = [];
            var record;
            for (record = this._mapHead; record !== null; record = record._next) {
              ListWrapper.push(items, stringify(record));
            }
            for (record = this._previousMapHead; record !== null; record = record._nextPrevious) {
              ListWrapper.push(previous, stringify(record));
            }
            for (record = this._changesHead; record !== null; record = record._nextChanged) {
              ListWrapper.push(changes, stringify(record));
            }
            for (record = this._additionsHead; record !== null; record = record._nextAdded) {
              ListWrapper.push(additions, stringify(record));
            }
            for (record = this._removalsHead; record !== null; record = record._nextRemoved) {
              ListWrapper.push(removals, stringify(record));
            }
            return "map: " + items.join(', ') + "\n" + "previous: " + previous.join(', ') + "\n" + "additions: " + additions.join(', ') + "\n" + "changes: " + changes.join(', ') + "\n" + "removals: " + removals.join(', ') + "\n";
          },
          _forEach: function(obj, fn) {
            if (obj instanceof Map) {
              MapWrapper.forEach(obj, fn);
            } else {
              StringMapWrapper.forEach(obj, fn);
            }
          }
        }, {supportsObj: function(obj) {
            return obj instanceof Map || isJsObject(obj);
          }}, $__super);
      }(Pipe)));
      Object.defineProperty(KeyValueChanges.prototype.forEachItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(KeyValueChanges.prototype.forEachPreviousItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(KeyValueChanges.prototype.forEachChangedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(KeyValueChanges.prototype.forEachAddedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(KeyValueChanges.prototype.forEachRemovedItem, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._truncate, "parameters", {get: function() {
          return [[KVChangeRecord], [KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._isInRemovals, "parameters", {get: function() {
          return [[KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._addToRemovals, "parameters", {get: function() {
          return [[KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._removeFromSeq, "parameters", {get: function() {
          return [[KVChangeRecord], [KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._removeFromRemovals, "parameters", {get: function() {
          return [[KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._addToAdditions, "parameters", {get: function() {
          return [[KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._addToChanges, "parameters", {get: function() {
          return [[KVChangeRecord]];
        }});
      Object.defineProperty(KeyValueChanges.prototype._forEach, "parameters", {get: function() {
          return [[], [Function]];
        }});
      KVChangeRecord = $__export("KVChangeRecord", (function() {
        var KVChangeRecord = function KVChangeRecord(key) {
          this.key = key;
          this.previousValue = null;
          this.currentValue = null;
          this._nextPrevious = null;
          this._next = null;
          this._nextAdded = null;
          this._nextRemoved = null;
          this._prevRemoved = null;
          this._nextChanged = null;
        };
        return ($traceurRuntime.createClass)(KVChangeRecord, {toString: function() {
            return looseIdentical(this.previousValue, this.currentValue) ? stringify(this.key) : (stringify(this.key) + '[' + stringify(this.previousValue) + '->' + stringify(this.currentValue) + ']');
          }}, {});
      }()));
    }
  };
});

System.register("angular2/src/change_detection/pipes/null_pipe", ["angular2/src/facade/lang", "angular2/src/change_detection/pipes/pipe"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/pipes/null_pipe";
  var isBlank,
      Pipe,
      NO_CHANGE,
      NullPipeFactory,
      NullPipe;
  return {
    setters: [function($__m) {
      isBlank = $__m.isBlank;
    }, function($__m) {
      Pipe = $__m.Pipe;
      NO_CHANGE = $__m.NO_CHANGE;
    }],
    execute: function() {
      NullPipeFactory = $__export("NullPipeFactory", (function() {
        var NullPipeFactory = function NullPipeFactory() {
          ;
        };
        return ($traceurRuntime.createClass)(NullPipeFactory, {
          supports: function(obj) {
            return NullPipe.supportsObj(obj);
          },
          create: function(bpc) {
            return new NullPipe();
          }
        }, {});
      }()));
      NullPipe = $__export("NullPipe", (function($__super) {
        var NullPipe = function NullPipe() {
          $traceurRuntime.superConstructor(NullPipe).call(this);
          this.called = false;
        };
        return ($traceurRuntime.createClass)(NullPipe, {
          supports: function(obj) {
            return NullPipe.supportsObj(obj);
          },
          transform: function(value) {
            if (!this.called) {
              this.called = true;
              return null;
            } else {
              return NO_CHANGE;
            }
          }
        }, {supportsObj: function(obj) {
            return isBlank(obj);
          }}, $__super);
      }(Pipe)));
    }
  };
});

System.register("angular2/src/core/annotations/visibility", ["angular2/src/facade/lang", "angular2/di"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/annotations/visibility";
  var CONST,
      DependencyAnnotation,
      Parent,
      Ancestor;
  return {
    setters: [function($__m) {
      CONST = $__m.CONST;
    }, function($__m) {
      DependencyAnnotation = $__m.DependencyAnnotation;
    }],
    execute: function() {
      Parent = $__export("Parent", (function($__super) {
        var Parent = function Parent() {
          $traceurRuntime.superConstructor(Parent).call(this);
        };
        return ($traceurRuntime.createClass)(Parent, {}, {}, $__super);
      }(DependencyAnnotation)));
      Object.defineProperty(Parent, "annotations", {get: function() {
          return [new CONST()];
        }});
      Ancestor = $__export("Ancestor", (function($__super) {
        var Ancestor = function Ancestor() {
          $traceurRuntime.superConstructor(Ancestor).call(this);
        };
        return ($traceurRuntime.createClass)(Ancestor, {}, {}, $__super);
      }(DependencyAnnotation)));
      Object.defineProperty(Ancestor, "annotations", {get: function() {
          return [new CONST()];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/interfaces", [], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/interfaces";
  var OnChange;
  return {
    setters: [],
    execute: function() {
      OnChange = $__export("OnChange", (function() {
        var OnChange = function OnChange() {
          ;
        };
        return ($traceurRuntime.createClass)(OnChange, {onChange: function(changes) {
            throw "OnChange.onChange is not implemented";
          }}, {});
      }()));
    }
  };
});

System.register("angular2/src/core/annotations/template", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/annotations/template";
  var ABSTRACT,
      CONST,
      Type,
      Template;
  return {
    setters: [function($__m) {
      ABSTRACT = $__m.ABSTRACT;
      CONST = $__m.CONST;
      Type = $__m.Type;
    }],
    execute: function() {
      Template = $__export("Template", (function() {
        var Template = function Template($__1) {
          var $__2 = $__1,
              url = $__2.url,
              inline = $__2.inline,
              directives = $__2.directives,
              formatters = $__2.formatters,
              source = $__2.source,
              locale = $__2.locale,
              device = $__2.device;
          this.url = url;
          this.inline = inline;
          this.directives = directives;
          this.formatters = formatters;
          this.source = source;
          this.locale = locale;
          this.device = device;
        };
        return ($traceurRuntime.createClass)(Template, {}, {});
      }()));
      Object.defineProperty(Template, "annotations", {get: function() {
          return [new CONST()];
        }});
    }
  };
});

System.register("angular2/src/dom/dom_adapter", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/dom/dom_adapter";
  var ABSTRACT,
      BaseException,
      DOM,
      DomAdapter;
  function setRootDomAdapter(adapter) {
    $__export("DOM", DOM = adapter);
  }
  function _abstract() {
    return new BaseException('This method is abstract');
  }
  $__export("setRootDomAdapter", setRootDomAdapter);
  return {
    setters: [function($__m) {
      ABSTRACT = $__m.ABSTRACT;
      BaseException = $__m.BaseException;
    }],
    execute: function() {
      DOM = $__export("DOM", DOM);
      Object.defineProperty(setRootDomAdapter, "parameters", {get: function() {
          return [[DomAdapter]];
        }});
      DomAdapter = $__export("DomAdapter", (function() {
        var DomAdapter = function DomAdapter() {
          ;
        };
        return ($traceurRuntime.createClass)(DomAdapter, {
          get attrToPropMap() {
            throw _abstract();
          },
          parse: function(templateHtml) {
            throw _abstract();
          },
          query: function(selector) {
            throw _abstract();
          },
          querySelector: function(el, selector) {
            throw _abstract();
          },
          querySelectorAll: function(el, selector) {
            throw _abstract();
          },
          on: function(el, evt, listener) {
            throw _abstract();
          },
          dispatchEvent: function(el, evt) {
            throw _abstract();
          },
          createMouseEvent: function(eventType) {
            throw _abstract();
          },
          createEvent: function(eventType) {
            throw _abstract();
          },
          getInnerHTML: function(el) {
            throw _abstract();
          },
          getOuterHTML: function(el) {
            throw _abstract();
          },
          nodeName: function(node) {
            throw _abstract();
          },
          nodeValue: function(node) {
            throw _abstract();
          },
          type: function(node) {
            throw _abstract();
          },
          content: function(node) {
            throw _abstract();
          },
          firstChild: function(el) {
            throw _abstract();
          },
          nextSibling: function(el) {
            throw _abstract();
          },
          parentElement: function(el) {
            throw _abstract();
          },
          childNodes: function(el) {
            throw _abstract();
          },
          childNodesAsList: function(el) {
            throw _abstract();
          },
          clearNodes: function(el) {
            throw _abstract();
          },
          appendChild: function(el, node) {
            throw _abstract();
          },
          removeChild: function(el, node) {
            throw _abstract();
          },
          replaceChild: function(el, newNode, oldNode) {
            throw _abstract();
          },
          remove: function(el) {
            throw _abstract();
          },
          insertBefore: function(el, node) {
            throw _abstract();
          },
          insertAllBefore: function(el, nodes) {
            throw _abstract();
          },
          insertAfter: function(el, node) {
            throw _abstract();
          },
          setInnerHTML: function(el, value) {
            throw _abstract();
          },
          getText: function(el) {
            throw _abstract();
          },
          setText: function(el, value) {
            throw _abstract();
          },
          getValue: function(el) {
            throw _abstract();
          },
          setValue: function(el, value) {
            throw _abstract();
          },
          getChecked: function(el) {
            throw _abstract();
          },
          setChecked: function(el, value) {
            throw _abstract();
          },
          createTemplate: function(html) {
            throw _abstract();
          },
          createElement: function(tagName) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : null;
            throw _abstract();
          },
          createTextNode: function(text) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : null;
            throw _abstract();
          },
          createScriptTag: function(attrName, attrValue) {
            var doc = arguments[2] !== (void 0) ? arguments[2] : null;
            throw _abstract();
          },
          createStyleElement: function(css) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : null;
            throw _abstract();
          },
          createShadowRoot: function(el) {
            throw _abstract();
          },
          getShadowRoot: function(el) {
            throw _abstract();
          },
          getHost: function(el) {
            throw _abstract();
          },
          getDistributedNodes: function(el) {
            throw _abstract();
          },
          clone: function(node) {
            throw _abstract();
          },
          hasProperty: function(element, name) {
            throw _abstract();
          },
          getElementsByClassName: function(element, name) {
            throw _abstract();
          },
          getElementsByTagName: function(element, name) {
            throw _abstract();
          },
          classList: function(element) {
            throw _abstract();
          },
          addClass: function(element, classname) {
            throw _abstract();
          },
          removeClass: function(element, classname) {
            throw _abstract();
          },
          hasClass: function(element, classname) {
            throw _abstract();
          },
          setStyle: function(element, stylename, stylevalue) {
            throw _abstract();
          },
          removeStyle: function(element, stylename) {
            throw _abstract();
          },
          getStyle: function(element, stylename) {
            throw _abstract();
          },
          tagName: function(element) {
            throw _abstract();
          },
          attributeMap: function(element) {
            throw _abstract();
          },
          getAttribute: function(element, attribute) {
            throw _abstract();
          },
          setAttribute: function(element, name, value) {
            throw _abstract();
          },
          removeAttribute: function(element, attribute) {
            throw _abstract();
          },
          templateAwareRoot: function(el) {
            throw _abstract();
          },
          createHtmlDocument: function() {
            throw _abstract();
          },
          defaultDoc: function() {
            throw _abstract();
          },
          getTitle: function() {
            throw _abstract();
          },
          setTitle: function(newTitle) {
            throw _abstract();
          },
          elementMatches: function(n, selector) {
            throw _abstract();
          },
          isTemplateElement: function(el) {
            throw _abstract();
          },
          isTextNode: function(node) {
            throw _abstract();
          },
          isCommentNode: function(node) {
            throw _abstract();
          },
          isElementNode: function(node) {
            throw _abstract();
          },
          hasShadowRoot: function(node) {
            throw _abstract();
          },
          isShadowRoot: function(node) {
            throw _abstract();
          },
          importIntoDoc: function(node) {
            throw _abstract();
          },
          isPageRule: function(rule) {
            throw _abstract();
          },
          isStyleRule: function(rule) {
            throw _abstract();
          },
          isMediaRule: function(rule) {
            throw _abstract();
          },
          isKeyframesRule: function(rule) {
            throw _abstract();
          },
          getHref: function(element) {
            throw _abstract();
          },
          resolveAndSetHref: function(element, baseUrl, href) {
            throw _abstract();
          },
          cssToRules: function(css) {
            throw _abstract();
          },
          supportsDOMEvents: function() {
            throw _abstract();
          },
          supportsNativeShadowDOM: function() {
            throw _abstract();
          }
        }, {});
      }()));
      Object.defineProperty(DomAdapter, "annotations", {get: function() {
          return [new ABSTRACT()];
        }});
      Object.defineProperty(DomAdapter.prototype.parse, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.query, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.querySelector, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.querySelectorAll, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setText, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setValue, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setChecked, "parameters", {get: function() {
          return [[], [assert.type.boolean]];
        }});
      Object.defineProperty(DomAdapter.prototype.createTextNode, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(DomAdapter.prototype.createScriptTag, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], []];
        }});
      Object.defineProperty(DomAdapter.prototype.createStyleElement, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(DomAdapter.prototype.hasProperty, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.getElementsByClassName, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.getElementsByTagName, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.addClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.removeClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.hasClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setStyle, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.removeStyle, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.getStyle, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.getAttribute, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setAttribute, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.removeAttribute, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.setTitle, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.elementMatches, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.isTemplateElement, "parameters", {get: function() {
          return [[assert.type.any]];
        }});
      Object.defineProperty(DomAdapter.prototype.resolveAndSetHref, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(DomAdapter.prototype.cssToRules, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/dom/generic_browser_adapter", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter"], function($__export) {
  "";
  var __moduleName = "angular2/src/dom/generic_browser_adapter";
  var ABSTRACT,
      List,
      ListWrapper,
      isPresent,
      isFunction,
      DomAdapter,
      GenericBrowserDomAdapter;
  return {
    setters: [function($__m) {
      ABSTRACT = $__m.ABSTRACT;
      isPresent = $__m.isPresent;
      isFunction = $__m.isFunction;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      DomAdapter = $__m.DomAdapter;
    }],
    execute: function() {
      GenericBrowserDomAdapter = $__export("GenericBrowserDomAdapter", (function($__super) {
        var GenericBrowserDomAdapter = function GenericBrowserDomAdapter() {
          $traceurRuntime.superConstructor(GenericBrowserDomAdapter).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(GenericBrowserDomAdapter, {
          getDistributedNodes: function(el) {
            return el.getDistributedNodes();
          },
          resolveAndSetHref: function(el, baseUrl, href) {
            el.href = href == null ? baseUrl : baseUrl + '/../' + href;
          },
          cssToRules: function(css) {
            var style = this.createStyleElement(css);
            this.appendChild(this.defaultDoc().head, style);
            var rules = ListWrapper.create();
            if (isPresent(style.sheet)) {
              try {
                var rawRules = style.sheet.cssRules;
                rules = ListWrapper.createFixedSize(rawRules.length);
                for (var i = 0; i < rawRules.length; i++) {
                  rules[i] = rawRules[i];
                }
              } catch (e) {}
            } else {}
            this.remove(style);
            return rules;
          },
          supportsDOMEvents: function() {
            return true;
          },
          supportsNativeShadowDOM: function() {
            return isFunction(this.defaultDoc().body.createShadowRoot);
          }
        }, {}, $__super);
      }(DomAdapter)));
      Object.defineProperty(GenericBrowserDomAdapter, "annotations", {get: function() {
          return [new ABSTRACT()];
        }});
      Object.defineProperty(GenericBrowserDomAdapter.prototype.resolveAndSetHref, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(GenericBrowserDomAdapter.prototype.cssToRules, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/annotations/annotations", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/di"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/annotations/annotations";
  var ABSTRACT,
      CONST,
      normalizeBlank,
      isPresent,
      ListWrapper,
      List,
      Injectable,
      Directive,
      Component,
      DynamicComponent,
      Decorator,
      Viewport,
      onDestroy,
      onChange,
      onAllChangesDone;
  return {
    setters: [function($__m) {
      ABSTRACT = $__m.ABSTRACT;
      CONST = $__m.CONST;
      normalizeBlank = $__m.normalizeBlank;
      isPresent = $__m.isPresent;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
    }, function($__m) {
      Injectable = $__m.Injectable;
    }],
    execute: function() {
      Directive = $__export("Directive", (function($__super) {
        var Directive = function Directive() {
          var $__1 = arguments[0] !== (void 0) ? arguments[0] : {},
              selector = $__1.selector,
              bind = $__1.bind,
              events = $__1.events,
              lifecycle = $__1.lifecycle;
          $traceurRuntime.superConstructor(Directive).call(this);
          this.selector = selector;
          this.bind = bind;
          this.events = events;
          this.lifecycle = lifecycle;
        };
        return ($traceurRuntime.createClass)(Directive, {hasLifecycleHook: function(hook) {
            return isPresent(this.lifecycle) ? ListWrapper.contains(this.lifecycle, hook) : false;
          }}, {}, $__super);
      }(Injectable)));
      Object.defineProperty(Directive, "annotations", {get: function() {
          return [new ABSTRACT(), new CONST()];
        }});
      Object.defineProperty(Directive.prototype.hasLifecycleHook, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Component = $__export("Component", (function($__super) {
        var Component = function Component() {
          var $__1 = arguments[0] !== (void 0) ? arguments[0] : {},
              selector = $__1.selector,
              bind = $__1.bind,
              events = $__1.events,
              services = $__1.services,
              lifecycle = $__1.lifecycle,
              changeDetection = $__1.changeDetection;
          $traceurRuntime.superConstructor(Component).call(this, {
            selector: selector,
            bind: bind,
            events: events,
            lifecycle: lifecycle
          });
          this.changeDetection = changeDetection;
          this.services = services;
        };
        return ($traceurRuntime.createClass)(Component, {}, {}, $__super);
      }(Directive)));
      Object.defineProperty(Component, "annotations", {get: function() {
          return [new CONST()];
        }});
      DynamicComponent = $__export("DynamicComponent", (function($__super) {
        var DynamicComponent = function DynamicComponent() {
          var $__1 = arguments[0] !== (void 0) ? arguments[0] : {},
              selector = $__1.selector,
              bind = $__1.bind,
              events = $__1.events,
              services = $__1.services,
              lifecycle = $__1.lifecycle;
          $traceurRuntime.superConstructor(DynamicComponent).call(this, {
            selector: selector,
            bind: bind,
            events: events,
            lifecycle: lifecycle
          });
          this.services = services;
        };
        return ($traceurRuntime.createClass)(DynamicComponent, {}, {}, $__super);
      }(Directive)));
      Object.defineProperty(DynamicComponent, "annotations", {get: function() {
          return [new CONST()];
        }});
      Decorator = $__export("Decorator", (function($__super) {
        var Decorator = function Decorator() {
          var $__2;
          var $__1 = arguments[0] !== (void 0) ? arguments[0] : {},
              selector = $__1.selector,
              bind = $__1.bind,
              events = $__1.events,
              lifecycle = $__1.lifecycle,
              compileChildren = ($__2 = $__1.compileChildren) === void 0 ? true : $__2;
          $traceurRuntime.superConstructor(Decorator).call(this, {
            selector: selector,
            bind: bind,
            events: events,
            lifecycle: lifecycle
          });
          this.compileChildren = compileChildren;
        };
        return ($traceurRuntime.createClass)(Decorator, {}, {}, $__super);
      }(Directive)));
      Object.defineProperty(Decorator, "annotations", {get: function() {
          return [new CONST()];
        }});
      Viewport = $__export("Viewport", (function($__super) {
        var Viewport = function Viewport() {
          var $__1 = arguments[0] !== (void 0) ? arguments[0] : {},
              selector = $__1.selector,
              bind = $__1.bind,
              events = $__1.events,
              lifecycle = $__1.lifecycle;
          $traceurRuntime.superConstructor(Viewport).call(this, {
            selector: selector,
            bind: bind,
            events: events,
            lifecycle: lifecycle
          });
        };
        return ($traceurRuntime.createClass)(Viewport, {}, {}, $__super);
      }(Directive)));
      Object.defineProperty(Viewport, "annotations", {get: function() {
          return [new CONST()];
        }});
      onDestroy = $__export("onDestroy", "onDestroy");
      onChange = $__export("onChange", "onChange");
      onAllChangesDone = $__export("onAllChangesDone", "onAllChangesDone");
    }
  };
});

System.register("angular2/src/core/compiler/directive_metadata", ["angular2/src/facade/lang", "angular2/src/core/annotations/annotations"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/directive_metadata";
  var Type,
      Directive,
      DirectiveMetadata;
  return {
    setters: [function($__m) {
      Type = $__m.Type;
    }, function($__m) {
      Directive = $__m.Directive;
    }],
    execute: function() {
      DirectiveMetadata = $__export("DirectiveMetadata", (function() {
        var DirectiveMetadata = function DirectiveMetadata(type, annotation) {
          this.annotation = annotation;
          this.type = type;
        };
        return ($traceurRuntime.createClass)(DirectiveMetadata, {}, {});
      }()));
      Object.defineProperty(DirectiveMetadata, "parameters", {get: function() {
          return [[Type], [Directive]];
        }});
    }
  };
});

System.register("angular2/src/facade/math", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/facade/math";
  var global,
      Math,
      NaN;
  return {
    setters: [function($__m) {
      global = $__m.global;
    }],
    execute: function() {
      Math = $__export("Math", global.Math);
      NaN = $__export("NaN", global.NaN);
    }
  };
});

System.register("angular2/src/core/annotations/di", ["angular2/src/facade/lang", "angular2/di"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/annotations/di";
  var CONST,
      DependencyAnnotation,
      EventEmitter,
      PropertySetter,
      Attribute;
  return {
    setters: [function($__m) {
      CONST = $__m.CONST;
    }, function($__m) {
      DependencyAnnotation = $__m.DependencyAnnotation;
    }],
    execute: function() {
      EventEmitter = $__export("EventEmitter", (function($__super) {
        var EventEmitter = function EventEmitter(eventName) {
          $traceurRuntime.superConstructor(EventEmitter).call(this);
          this.eventName = eventName;
        };
        return ($traceurRuntime.createClass)(EventEmitter, {get token() {
            return Function;
          }}, {}, $__super);
      }(DependencyAnnotation)));
      Object.defineProperty(EventEmitter, "annotations", {get: function() {
          return [new CONST()];
        }});
      PropertySetter = $__export("PropertySetter", (function($__super) {
        var PropertySetter = function PropertySetter(propName) {
          $traceurRuntime.superConstructor(PropertySetter).call(this);
          this.propName = propName;
        };
        return ($traceurRuntime.createClass)(PropertySetter, {get token() {
            return Function;
          }}, {}, $__super);
      }(DependencyAnnotation)));
      Object.defineProperty(PropertySetter, "annotations", {get: function() {
          return [new CONST()];
        }});
      Attribute = $__export("Attribute", (function($__super) {
        var Attribute = function Attribute(attributeName) {
          $traceurRuntime.superConstructor(Attribute).call(this);
          this.attributeName = attributeName;
        };
        return ($traceurRuntime.createClass)(Attribute, {}, {}, $__super);
      }(DependencyAnnotation)));
      Object.defineProperty(Attribute, "annotations", {get: function() {
          return [new CONST()];
        }});
    }
  };
});

System.register("angular2/src/core/zone/vm_turn_zone", ["angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/zone/vm_turn_zone";
  var List,
      ListWrapper,
      StringMapWrapper,
      normalizeBlank,
      isPresent,
      global,
      VmTurnZone;
  return {
    setters: [function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      normalizeBlank = $__m.normalizeBlank;
      isPresent = $__m.isPresent;
      global = $__m.global;
    }],
    execute: function() {
      VmTurnZone = $__export("VmTurnZone", (function() {
        var VmTurnZone = function VmTurnZone($__2) {
          var enableLongStackTrace = $__2.enableLongStackTrace;
          this._nestedRunCounter = 0;
          this._onTurnStart = null;
          this._onTurnDone = null;
          this._onErrorHandler = null;
          this._outerZone = global.zone;
          this._innerZone = this._createInnerZone(this._outerZone, enableLongStackTrace);
        };
        return ($traceurRuntime.createClass)(VmTurnZone, {
          initCallbacks: function() {
            var $__2 = arguments[0] !== (void 0) ? arguments[0] : {},
                onTurnStart = $__2.onTurnStart,
                onTurnDone = $__2.onTurnDone,
                onScheduleMicrotask = $__2.onScheduleMicrotask,
                onErrorHandler = $__2.onErrorHandler;
            this._onTurnStart = normalizeBlank(onTurnStart);
            this._onTurnDone = normalizeBlank(onTurnDone);
            this._onErrorHandler = normalizeBlank(onErrorHandler);
          },
          run: function(fn) {
            return this._innerZone.run(fn);
          },
          runOutsideAngular: function(fn) {
            return this._outerZone.run(fn);
          },
          _createInnerZone: function(zone, enableLongStackTrace) {
            var $__0 = this;
            var vmTurnZone = this;
            var errorHandling;
            if (enableLongStackTrace) {
              errorHandling = StringMapWrapper.merge(Zone.longStackTraceZone, {onError: function(e) {
                  vmTurnZone._onError(this, e);
                }});
            } else {
              errorHandling = {onError: function(e) {
                  vmTurnZone._onError(this, e);
                }};
            }
            return zone.fork(errorHandling).fork({
              beforeTask: (function() {
                $__0._beforeTask();
              }),
              afterTask: (function() {
                $__0._afterTask();
              })
            });
          },
          _beforeTask: function() {
            this._nestedRunCounter++;
            if (this._nestedRunCounter === 1 && this._onTurnStart) {
              this._onTurnStart();
            }
          },
          _afterTask: function() {
            this._nestedRunCounter--;
            if (this._nestedRunCounter === 0 && this._onTurnDone) {
              this._onTurnDone();
            }
          },
          _onError: function(zone, e) {
            if (isPresent(this._onErrorHandler)) {
              var trace = [normalizeBlank(e.stack)];
              while (zone && zone.constructedAtException) {
                trace.push(zone.constructedAtException.get());
                zone = zone.parent;
              }
              this._onErrorHandler(e, trace);
            } else {
              throw e;
            }
          }
        }, {});
      }()));
    }
  };
});

System.register("angular2/src/core/compiler/shadow_dom_emulation/content_tag", ["angular2/src/core/compiler/shadow_dom_emulation/light_dom", "angular2/di", "angular2/src/dom/dom_adapter", "angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/shadow_dom_emulation/content_tag";
  var ldModule,
      Inject,
      Injectable,
      DOM,
      isPresent,
      List,
      ListWrapper,
      ContentStrategy,
      RenderedContent,
      IntermediateContent,
      Content;
  return {
    setters: [function($__m) {
      ldModule = $__m;
    }, function($__m) {
      Inject = $__m.Inject;
      Injectable = $__m.Injectable;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }],
    execute: function() {
      ContentStrategy = (function() {
        var ContentStrategy = function ContentStrategy() {
          ;
        };
        return ($traceurRuntime.createClass)(ContentStrategy, {insert: function(nodes) {}}, {});
      }());
      Object.defineProperty(ContentStrategy.prototype.insert, "parameters", {get: function() {
          return [[List]];
        }});
      RenderedContent = (function($__super) {
        var RenderedContent = function RenderedContent(contentEl) {
          $traceurRuntime.superConstructor(RenderedContent).call(this);
          this.beginScript = contentEl;
          this.endScript = DOM.nextSibling(this.beginScript);
          this.nodes = [];
        };
        return ($traceurRuntime.createClass)(RenderedContent, {
          insert: function(nodes) {
            this.nodes = nodes;
            DOM.insertAllBefore(this.endScript, nodes);
            this._removeNodesUntil(ListWrapper.isEmpty(nodes) ? this.endScript : nodes[0]);
          },
          _removeNodesUntil: function(node) {
            var p = DOM.parentElement(this.beginScript);
            for (var next = DOM.nextSibling(this.beginScript); next !== node; next = DOM.nextSibling(this.beginScript)) {
              DOM.removeChild(p, next);
            }
          }
        }, {}, $__super);
      }(ContentStrategy));
      Object.defineProperty(RenderedContent, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(RenderedContent.prototype.insert, "parameters", {get: function() {
          return [[List]];
        }});
      IntermediateContent = (function($__super) {
        var IntermediateContent = function IntermediateContent(destinationLightDom) {
          $traceurRuntime.superConstructor(IntermediateContent).call(this);
          this.destinationLightDom = destinationLightDom;
          this.nodes = [];
        };
        return ($traceurRuntime.createClass)(IntermediateContent, {insert: function(nodes) {
            this.nodes = nodes;
            this.destinationLightDom.redistribute();
          }}, {}, $__super);
      }(ContentStrategy));
      Object.defineProperty(IntermediateContent, "parameters", {get: function() {
          return [[ldModule.LightDom]];
        }});
      Object.defineProperty(IntermediateContent.prototype.insert, "parameters", {get: function() {
          return [[List]];
        }});
      Content = $__export("Content", (function() {
        var Content = function Content(destinationLightDom, contentStartEl, selector) {
          this.select = selector;
          this.contentStartElement = contentStartEl;
          this._strategy = isPresent(destinationLightDom) ? new IntermediateContent(destinationLightDom) : new RenderedContent(contentStartEl);
        };
        return ($traceurRuntime.createClass)(Content, {
          nodes: function() {
            return this._strategy.nodes;
          },
          insert: function(nodes) {
            this._strategy.insert(nodes);
          }
        }, {});
      }()));
      Object.defineProperty(Content, "parameters", {get: function() {
          return [[ldModule.LightDom], [], [assert.type.string]];
        }});
      Object.defineProperty(Content.prototype.insert, "parameters", {get: function() {
          return [[List]];
        }});
    }
  };
});

System.register("angular2/src/core/dom/element", ["angular2/src/dom/dom_adapter", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/dom/element";
  var DOM,
      normalizeBlank,
      NgElement;
  return {
    setters: [function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      normalizeBlank = $__m.normalizeBlank;
    }],
    execute: function() {
      NgElement = $__export("NgElement", (function() {
        var NgElement = function NgElement(domElement) {
          this.domElement = domElement;
        };
        return ($traceurRuntime.createClass)(NgElement, {getAttribute: function(name) {
            return normalizeBlank(DOM.getAttribute(this.domElement, name));
          }}, {});
      }()));
      Object.defineProperty(NgElement.prototype.getAttribute, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/shadow_dom/shadow_css", ["angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/shadow_dom/shadow_css";
  var DOM,
      List,
      ListWrapper,
      StringWrapper,
      RegExp,
      RegExpWrapper,
      RegExpMatcherWrapper,
      isPresent,
      isBlank,
      BaseException,
      int,
      ShadowCss,
      _cssContentNextSelectorRe,
      _cssContentRuleRe,
      _cssContentUnscopedRuleRe,
      _polyfillHost,
      _polyfillHostContext,
      _parenSuffix,
      _cssColonHostRe,
      _cssColonHostContextRe,
      _polyfillHostNoCombinator,
      _shadowDOMSelectorsRe,
      _selectorReSuffix,
      _polyfillHostRe,
      _colonHostRe,
      _colonHostContextRe;
  function _cssToRules(cssText) {
    return DOM.cssToRules(cssText);
  }
  function _withCssRules(cssText, callback) {
    if (isBlank(callback))
      return ;
    var rules = _cssToRules(cssText);
    callback(rules);
  }
  return {
    setters: [function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      StringWrapper = $__m.StringWrapper;
      RegExp = $__m.RegExp;
      RegExpWrapper = $__m.RegExpWrapper;
      RegExpMatcherWrapper = $__m.RegExpMatcherWrapper;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      int = $__m.int;
    }],
    execute: function() {
      ShadowCss = $__export("ShadowCss", (function() {
        var ShadowCss = function ShadowCss() {
          this.strictStyling = true;
        };
        return ($traceurRuntime.createClass)(ShadowCss, {
          shimStyle: function(style, selector) {
            var hostSelector = arguments[2] !== (void 0) ? arguments[2] : '';
            var cssText = DOM.getText(style);
            return this.shimCssText(cssText, selector, hostSelector);
          },
          shimCssText: function(cssText, selector) {
            var hostSelector = arguments[2] !== (void 0) ? arguments[2] : '';
            cssText = this._insertDirectives(cssText);
            return this._scopeCssText(cssText, selector, hostSelector);
          },
          _insertDirectives: function(cssText) {
            cssText = this._insertPolyfillDirectivesInCssText(cssText);
            return this._insertPolyfillRulesInCssText(cssText);
          },
          _insertPolyfillDirectivesInCssText: function(cssText) {
            return StringWrapper.replaceAllMapped(cssText, _cssContentNextSelectorRe, function(m) {
              return m[1] + '{';
            });
          },
          _insertPolyfillRulesInCssText: function(cssText) {
            return StringWrapper.replaceAllMapped(cssText, _cssContentRuleRe, function(m) {
              var rule = m[0];
              rule = StringWrapper.replace(rule, m[1], '');
              rule = StringWrapper.replace(rule, m[2], '');
              return m[3] + rule;
            });
          },
          _scopeCssText: function(cssText, scopeSelector, hostSelector) {
            var $__0 = this;
            var unscoped = this._extractUnscopedRulesFromCssText(cssText);
            cssText = this._insertPolyfillHostInCssText(cssText);
            cssText = this._convertColonHost(cssText);
            cssText = this._convertColonHostContext(cssText);
            cssText = this._convertShadowDOMSelectors(cssText);
            if (isPresent(scopeSelector)) {
              _withCssRules(cssText, (function(rules) {
                cssText = $__0._scopeRules(rules, scopeSelector, hostSelector);
              }));
            }
            cssText = cssText + '\n' + unscoped;
            return cssText.trim();
          },
          _extractUnscopedRulesFromCssText: function(cssText) {
            var r = '',
                m;
            var matcher = RegExpWrapper.matcher(_cssContentUnscopedRuleRe, cssText);
            while (isPresent(m = RegExpMatcherWrapper.next(matcher))) {
              var rule = m[0];
              rule = StringWrapper.replace(rule, m[2], '');
              rule = StringWrapper.replace(rule, m[1], m[3]);
              r = rule + '\n\n';
            }
            return r;
          },
          _convertColonHost: function(cssText) {
            return this._convertColonRule(cssText, _cssColonHostRe, this._colonHostPartReplacer);
          },
          _convertColonHostContext: function(cssText) {
            return this._convertColonRule(cssText, _cssColonHostContextRe, this._colonHostContextPartReplacer);
          },
          _convertColonRule: function(cssText, regExp, partReplacer) {
            return StringWrapper.replaceAllMapped(cssText, regExp, function(m) {
              if (isPresent(m[2])) {
                var parts = m[2].split(','),
                    r = [];
                for (var i = 0; i < parts.length; i++) {
                  var p = parts[i];
                  if (isBlank(p))
                    break;
                  p = p.trim();
                  ListWrapper.push(r, partReplacer(_polyfillHostNoCombinator, p, m[3]));
                }
                return r.join(',');
              } else {
                return _polyfillHostNoCombinator + m[3];
              }
            });
          },
          _colonHostContextPartReplacer: function(host, part, suffix) {
            if (StringWrapper.contains(part, _polyfillHost)) {
              return this._colonHostPartReplacer(host, part, suffix);
            } else {
              return host + part + suffix + ', ' + part + ' ' + host + suffix;
            }
          },
          _colonHostPartReplacer: function(host, part, suffix) {
            return host + StringWrapper.replace(part, _polyfillHost, '') + suffix;
          },
          _convertShadowDOMSelectors: function(cssText) {
            for (var i = 0; i < _shadowDOMSelectorsRe.length; i++) {
              cssText = StringWrapper.replaceAll(cssText, _shadowDOMSelectorsRe[i], ' ');
            }
            return cssText;
          },
          _scopeRules: function(cssRules, scopeSelector, hostSelector) {
            var cssText = '';
            if (isPresent(cssRules)) {
              for (var i = 0; i < cssRules.length; i++) {
                var rule = cssRules[i];
                if (DOM.isStyleRule(rule) || DOM.isPageRule(rule)) {
                  cssText += this._scopeSelector(rule.selectorText, scopeSelector, hostSelector, this.strictStyling) + ' {\n';
                  cssText += this._propertiesFromRule(rule) + '\n}\n\n';
                } else if (DOM.isMediaRule(rule)) {
                  cssText += '@media ' + rule.media.mediaText + ' {\n';
                  cssText += this._scopeRules(rule.cssRules, scopeSelector, hostSelector);
                  cssText += '\n}\n\n';
                } else {
                  try {
                    if (isPresent(rule.cssText)) {
                      cssText += rule.cssText + '\n\n';
                    }
                  } catch (x) {
                    if (DOM.isKeyframesRule(rule) && isPresent(rule.cssRules)) {
                      cssText += this._ieSafeCssTextFromKeyFrameRule(rule);
                    }
                  }
                }
              }
            }
            return cssText;
          },
          _ieSafeCssTextFromKeyFrameRule: function(rule) {
            var cssText = '@keyframes ' + rule.name + ' {';
            for (var i = 0; i < rule.cssRules.length; i++) {
              var r = rule.cssRules[i];
              cssText += ' ' + r.keyText + ' {' + r.style.cssText + '}';
            }
            cssText += ' }';
            return cssText;
          },
          _scopeSelector: function(selector, scopeSelector, hostSelector, strict) {
            var r = [],
                parts = selector.split(',');
            for (var i = 0; i < parts.length; i++) {
              var p = parts[i];
              p = p.trim();
              if (this._selectorNeedsScoping(p, scopeSelector)) {
                p = strict && !StringWrapper.contains(p, _polyfillHostNoCombinator) ? this._applyStrictSelectorScope(p, scopeSelector) : this._applySelectorScope(p, scopeSelector, hostSelector);
              }
              ListWrapper.push(r, p);
            }
            return r.join(', ');
          },
          _selectorNeedsScoping: function(selector, scopeSelector) {
            var re = this._makeScopeMatcher(scopeSelector);
            return !isPresent(RegExpWrapper.firstMatch(re, selector));
          },
          _makeScopeMatcher: function(scopeSelector) {
            var lre = RegExpWrapper.create('\\[');
            var rre = RegExpWrapper.create('\\]');
            scopeSelector = StringWrapper.replaceAll(scopeSelector, lre, '\\[');
            scopeSelector = StringWrapper.replaceAll(scopeSelector, rre, '\\]');
            return RegExpWrapper.create('^(' + scopeSelector + ')' + _selectorReSuffix, 'm');
          },
          _applySelectorScope: function(selector, scopeSelector, hostSelector) {
            return this._applySimpleSelectorScope(selector, scopeSelector, hostSelector);
          },
          _applySimpleSelectorScope: function(selector, scopeSelector, hostSelector) {
            if (isPresent(RegExpWrapper.firstMatch(_polyfillHostRe, selector))) {
              var replaceBy = this.strictStyling ? ("[" + hostSelector + "]") : scopeSelector;
              selector = StringWrapper.replace(selector, _polyfillHostNoCombinator, replaceBy);
              return StringWrapper.replaceAll(selector, _polyfillHostRe, replaceBy + ' ');
            } else {
              return scopeSelector + ' ' + selector;
            }
          },
          _applyStrictSelectorScope: function(selector, scopeSelector) {
            var isRe = RegExpWrapper.create('\\[is=([^\\]]*)\\]');
            scopeSelector = StringWrapper.replaceAllMapped(scopeSelector, isRe, (function(m) {
              return m[1];
            }));
            var splits = [' ', '>', '+', '~'],
                scoped = selector,
                attrName = '[' + scopeSelector + ']';
            for (var i = 0; i < splits.length; i++) {
              var sep = splits[i];
              var parts = scoped.split(sep);
              scoped = ListWrapper.map(parts, function(p) {
                var t = StringWrapper.replaceAll(p.trim(), _polyfillHostRe, '');
                if (t.length > 0 && !ListWrapper.contains(splits, t) && !StringWrapper.contains(t, attrName)) {
                  var re = RegExpWrapper.create('([^:]*)(:*)(.*)');
                  var m = RegExpWrapper.firstMatch(re, t);
                  if (isPresent(m)) {
                    p = m[1] + attrName + m[2] + m[3];
                  }
                }
                return p;
              }).join(sep);
            }
            return scoped;
          },
          _insertPolyfillHostInCssText: function(selector) {
            selector = StringWrapper.replaceAll(selector, _colonHostContextRe, _polyfillHostContext);
            selector = StringWrapper.replaceAll(selector, _colonHostRe, _polyfillHost);
            return selector;
          },
          _propertiesFromRule: function(rule) {
            var cssText = rule.style.cssText;
            var attrRe = RegExpWrapper.create('[\'"]+|attr');
            if (rule.style.content.length > 0 && !isPresent(RegExpWrapper.firstMatch(attrRe, rule.style.content))) {
              var contentRe = RegExpWrapper.create('content:[^;]*;');
              cssText = StringWrapper.replaceAll(cssText, contentRe, 'content: \'' + rule.style.content + '\';');
            }
            return cssText;
          }
        }, {});
      }()));
      Object.defineProperty(ShadowCss.prototype.shimStyle, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype.shimCssText, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._insertDirectives, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._insertPolyfillDirectivesInCssText, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._insertPolyfillRulesInCssText, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._scopeCssText, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._extractUnscopedRulesFromCssText, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._convertColonHost, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._convertColonHostContext, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._convertColonRule, "parameters", {get: function() {
          return [[assert.type.string], [RegExp], [Function]];
        }});
      Object.defineProperty(ShadowCss.prototype._colonHostContextPartReplacer, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._colonHostPartReplacer, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._convertShadowDOMSelectors, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._scopeRules, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._scopeSelector, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string], [assert.type.boolean]];
        }});
      Object.defineProperty(ShadowCss.prototype._selectorNeedsScoping, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._makeScopeMatcher, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._applySelectorScope, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._applySimpleSelectorScope, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._applyStrictSelectorScope, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ShadowCss.prototype._insertPolyfillHostInCssText, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      _cssContentNextSelectorRe = RegExpWrapper.create('polyfill-next-selector[^}]*content:[\\s]*?[\'"](.*?)[\'"][;\\s]*}([^{]*?){', 'im');
      _cssContentRuleRe = RegExpWrapper.create('(polyfill-rule)[^}]*(content:[\\s]*[\'"](.*?)[\'"])[;\\s]*[^}]*}', 'im');
      _cssContentUnscopedRuleRe = RegExpWrapper.create('(polyfill-unscoped-rule)[^}]*(content:[\\s]*[\'"](.*?)[\'"])[;\\s]*[^}]*}', 'im');
      _polyfillHost = '-shadowcsshost';
      _polyfillHostContext = '-shadowcsscontext';
      _parenSuffix = ')(?:\\((' + '(?:\\([^)(]*\\)|[^)(]*)+?' + ')\\))?([^,{]*)';
      _cssColonHostRe = RegExpWrapper.create('(' + _polyfillHost + _parenSuffix, 'im');
      _cssColonHostContextRe = RegExpWrapper.create('(' + _polyfillHostContext + _parenSuffix, 'im');
      _polyfillHostNoCombinator = _polyfillHost + '-no-combinator';
      _shadowDOMSelectorsRe = [RegExpWrapper.create('>>>'), RegExpWrapper.create('::shadow'), RegExpWrapper.create('::content'), RegExpWrapper.create('/deep/'), RegExpWrapper.create('/shadow-deep/'), RegExpWrapper.create('/shadow/')];
      _selectorReSuffix = '([>\\s~+\[.,{:][\\s\\S]*)?$';
      _polyfillHostRe = RegExpWrapper.create(_polyfillHost, 'im');
      _colonHostRe = RegExpWrapper.create(':host', 'im');
      _colonHostContextRe = RegExpWrapper.create(':host-context', 'im');
      Object.defineProperty(_cssToRules, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_withCssRules, "parameters", {get: function() {
          return [[assert.type.string], [Function]];
        }});
    }
  };
});

System.register("angular2/src/services/xhr", ["angular2/src/facade/async"], function($__export) {
  "";
  var __moduleName = "angular2/src/services/xhr";
  var Promise,
      XHR;
  return {
    setters: [function($__m) {
      Promise = $__m.Promise;
    }],
    execute: function() {
      XHR = $__export("XHR", (function() {
        var XHR = function XHR() {
          ;
        };
        return ($traceurRuntime.createClass)(XHR, {get: function(url) {
            return null;
          }}, {});
      }()));
      Object.defineProperty(XHR.prototype.get, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/services/url_resolver", ["angular2/di", "angular2/src/facade/lang", "angular2/src/dom/dom_adapter"], function($__export) {
  "";
  var __moduleName = "angular2/src/services/url_resolver";
  var Injectable,
      isPresent,
      isBlank,
      RegExpWrapper,
      BaseException,
      DOM,
      UrlResolver,
      _schemeRe;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      RegExpWrapper = $__m.RegExpWrapper;
      BaseException = $__m.BaseException;
    }, function($__m) {
      DOM = $__m.DOM;
    }],
    execute: function() {
      UrlResolver = $__export("UrlResolver", (function() {
        var UrlResolver = function UrlResolver() {
          if (isBlank(UrlResolver.a)) {
            UrlResolver.a = DOM.createElement('a');
          }
        };
        return ($traceurRuntime.createClass)(UrlResolver, {resolve: function(baseUrl, url) {
            if (isBlank(baseUrl)) {
              DOM.resolveAndSetHref(UrlResolver.a, url, null);
              return DOM.getHref(UrlResolver.a);
            }
            if (isBlank(url) || url == '')
              return baseUrl;
            if (url[0] == '/') {
              throw new BaseException(("Could not resolve the url " + url + " from " + baseUrl));
            }
            var m = RegExpWrapper.firstMatch(_schemeRe, url);
            if (isPresent(m[1])) {
              return url;
            }
            DOM.resolveAndSetHref(UrlResolver.a, baseUrl, url);
            return DOM.getHref(UrlResolver.a);
          }}, {});
      }()));
      Object.defineProperty(UrlResolver, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(UrlResolver.prototype.resolve, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      _schemeRe = RegExpWrapper.create('^([^:/?#]+:)?');
    }
  };
});

System.register("angular2/src/render/dom/shadow_dom/style_url_resolver", ["angular2/di", "angular2/src/facade/lang", "angular2/src/services/url_resolver"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/shadow_dom/style_url_resolver";
  var Injectable,
      RegExp,
      RegExpWrapper,
      StringWrapper,
      UrlResolver,
      StyleUrlResolver,
      _cssUrlRe,
      _cssImportRe,
      _quoteRe;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      RegExp = $__m.RegExp;
      RegExpWrapper = $__m.RegExpWrapper;
      StringWrapper = $__m.StringWrapper;
    }, function($__m) {
      UrlResolver = $__m.UrlResolver;
    }],
    execute: function() {
      StyleUrlResolver = $__export("StyleUrlResolver", (function() {
        var StyleUrlResolver = function StyleUrlResolver(resolver) {
          this._resolver = resolver;
        };
        return ($traceurRuntime.createClass)(StyleUrlResolver, {
          resolveUrls: function(cssText, baseUrl) {
            cssText = this._replaceUrls(cssText, _cssUrlRe, baseUrl);
            cssText = this._replaceUrls(cssText, _cssImportRe, baseUrl);
            return cssText;
          },
          _replaceUrls: function(cssText, re, baseUrl) {
            var $__0 = this;
            return StringWrapper.replaceAllMapped(cssText, re, (function(m) {
              var pre = m[1];
              var url = StringWrapper.replaceAll(m[2], _quoteRe, '');
              var post = m[3];
              var resolvedUrl = $__0._resolver.resolve(baseUrl, url);
              return pre + "'" + resolvedUrl + "'" + post;
            }));
          }
        }, {});
      }()));
      Object.defineProperty(StyleUrlResolver, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(StyleUrlResolver, "parameters", {get: function() {
          return [[UrlResolver]];
        }});
      Object.defineProperty(StyleUrlResolver.prototype.resolveUrls, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(StyleUrlResolver.prototype._replaceUrls, "parameters", {get: function() {
          return [[assert.type.string], [RegExp], [assert.type.string]];
        }});
      _cssUrlRe = RegExpWrapper.create('(url\\()([^)]*)(\\))');
      _cssImportRe = RegExpWrapper.create('(@import[\\s]+(?!url\\())[\'"]([^\'"]*)[\'"](.*;)');
      _quoteRe = RegExpWrapper.create('[\'"]');
    }
  };
});

System.register("angular2/src/core/compiler/element_binder", ["angular2/src/facade/lang", "angular2/src/core/compiler/element_injector", "angular2/src/core/compiler/directive_metadata", "angular2/src/facade/collection", "angular2/src/core/compiler/view"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/element_binder";
  var int,
      isBlank,
      BaseException,
      eiModule,
      DirectiveMetadata,
      List,
      StringMap,
      viewModule,
      ElementBinder;
  return {
    setters: [function($__m) {
      int = $__m.int;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
    }, function($__m) {
      eiModule = $__m;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      List = $__m.List;
      StringMap = $__m.StringMap;
    }, function($__m) {
      viewModule = $__m;
    }],
    execute: function() {
      ElementBinder = $__export("ElementBinder", (function() {
        var ElementBinder = function ElementBinder(index, parent, distanceToParent, protoElementInjector, componentDirective, viewportDirective) {
          if (isBlank(index)) {
            throw new BaseException('null index not allowed.');
          }
          this.protoElementInjector = protoElementInjector;
          this.componentDirective = componentDirective;
          this.viewportDirective = viewportDirective;
          this.parent = parent;
          this.index = index;
          this.distanceToParent = distanceToParent;
          this.events = null;
          this.textNodeIndices = null;
          this.hasElementPropertyBindings = false;
          this.nestedProtoView = null;
          this.contentTagSelector = null;
        };
        return ($traceurRuntime.createClass)(ElementBinder, {}, {});
      }()));
      Object.defineProperty(ElementBinder, "parameters", {get: function() {
          return [[int], [ElementBinder], [int], [eiModule.ProtoElementInjector], [DirectiveMetadata], [DirectiveMetadata]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/string_utils", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/string_utils";
  var StringWrapper,
      RegExpWrapper,
      DASH_CASE_REGEXP,
      CAMEL_CASE_REGEXP;
  function dashCaseToCamelCase(input) {
    return StringWrapper.replaceAllMapped(input, DASH_CASE_REGEXP, (function(m) {
      return m[1].toUpperCase();
    }));
  }
  function camelCaseToDashCase(input) {
    return StringWrapper.replaceAllMapped(input, CAMEL_CASE_REGEXP, (function(m) {
      return '-' + m[1].toLowerCase();
    }));
  }
  $__export("dashCaseToCamelCase", dashCaseToCamelCase);
  $__export("camelCaseToDashCase", camelCaseToDashCase);
  return {
    setters: [function($__m) {
      StringWrapper = $__m.StringWrapper;
      RegExpWrapper = $__m.RegExpWrapper;
    }],
    execute: function() {
      DASH_CASE_REGEXP = RegExpWrapper.create('-([a-z])');
      CAMEL_CASE_REGEXP = RegExpWrapper.create('([A-Z])');
      Object.defineProperty(dashCaseToCamelCase, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(camelCaseToDashCase, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/compile_control", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_step"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/compile_control";
  var isBlank,
      List,
      ListWrapper,
      CompileElement,
      CompileStep,
      CompileControl;
  return {
    setters: [function($__m) {
      isBlank = $__m.isBlank;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }],
    execute: function() {
      CompileControl = $__export("CompileControl", (function() {
        var CompileControl = function CompileControl(steps) {
          this._steps = steps;
          this._currentStepIndex = 0;
          this._parent = null;
          this._results = null;
          this._additionalChildren = null;
        };
        return ($traceurRuntime.createClass)(CompileControl, {
          internalProcess: function(results, startStepIndex, parent, current) {
            this._results = results;
            var previousStepIndex = this._currentStepIndex;
            var previousParent = this._parent;
            for (var i = startStepIndex; i < this._steps.length; i++) {
              var step = this._steps[i];
              this._parent = parent;
              this._currentStepIndex = i;
              step.process(parent, current, this);
              parent = this._parent;
            }
            ListWrapper.push(results, current);
            this._currentStepIndex = previousStepIndex;
            this._parent = previousParent;
            var localAdditionalChildren = this._additionalChildren;
            this._additionalChildren = null;
            return localAdditionalChildren;
          },
          addParent: function(newElement) {
            this.internalProcess(this._results, this._currentStepIndex + 1, this._parent, newElement);
            this._parent = newElement;
          },
          addChild: function(element) {
            if (isBlank(this._additionalChildren)) {
              this._additionalChildren = ListWrapper.create();
            }
            ListWrapper.push(this._additionalChildren, element);
          }
        }, {});
      }()));
      Object.defineProperty(CompileControl.prototype.internalProcess, "parameters", {get: function() {
          return [[], [], [CompileElement], [CompileElement]];
        }});
      Object.defineProperty(CompileControl.prototype.addParent, "parameters", {get: function() {
          return [[CompileElement]];
        }});
      Object.defineProperty(CompileControl.prototype.addChild, "parameters", {get: function() {
          return [[CompileElement]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/util", ["angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/util";
  var StringWrapper,
      RegExpWrapper,
      isPresent,
      NG_BINDING_CLASS_SELECTOR,
      NG_BINDING_CLASS,
      CAMEL_CASE_REGEXP,
      DASH_CASE_REGEXP;
  function camelCaseToDashCase(input) {
    return StringWrapper.replaceAllMapped(input, CAMEL_CASE_REGEXP, (function(m) {
      return '-' + m[1].toLowerCase();
    }));
  }
  function dashCaseToCamelCase(input) {
    return StringWrapper.replaceAllMapped(input, DASH_CASE_REGEXP, (function(m) {
      return m[1].toUpperCase();
    }));
  }
  $__export("camelCaseToDashCase", camelCaseToDashCase);
  $__export("dashCaseToCamelCase", dashCaseToCamelCase);
  return {
    setters: [function($__m) {
      StringWrapper = $__m.StringWrapper;
      RegExpWrapper = $__m.RegExpWrapper;
      isPresent = $__m.isPresent;
    }],
    execute: function() {
      NG_BINDING_CLASS_SELECTOR = $__export("NG_BINDING_CLASS_SELECTOR", '.ng-binding');
      NG_BINDING_CLASS = $__export("NG_BINDING_CLASS", 'ng-binding');
      CAMEL_CASE_REGEXP = RegExpWrapper.create('([A-Z])');
      DASH_CASE_REGEXP = RegExpWrapper.create('-([a-z])');
      Object.defineProperty(camelCaseToDashCase, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(dashCaseToCamelCase, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/view_pool", ["angular2/src/facade/collection", "angular2/src/core/compiler/view"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/view_pool";
  var ListWrapper,
      MapWrapper,
      StringMapWrapper,
      List,
      viewModule,
      ViewPool;
  return {
    setters: [function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
      List = $__m.List;
    }, function($__m) {
      viewModule = $__m;
    }],
    execute: function() {
      ViewPool = $__export("ViewPool", (function() {
        var ViewPool = function ViewPool(capacity) {
          this._views = [];
          this._capacity = capacity;
        };
        return ($traceurRuntime.createClass)(ViewPool, {
          pop: function() {
            return ListWrapper.isEmpty(this._views) ? null : ListWrapper.removeLast(this._views);
          },
          push: function(view) {
            if (this._views.length < this._capacity) {
              ListWrapper.push(this._views, view);
            }
          },
          length: function() {
            return this._views.length;
          }
        }, {});
      }()));
      Object.defineProperty(ViewPool, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(ViewPool.prototype.push, "parameters", {get: function() {
          return [[viewModule.View]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/compile_pipeline", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control", "angular2/src/core/compiler/pipeline/compile_step"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/compile_pipeline";
  var isPresent,
      List,
      ListWrapper,
      DOM,
      CompileElement,
      CompileControl,
      CompileStep,
      CompilePipeline;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }],
    execute: function() {
      CompilePipeline = $__export("CompilePipeline", (function() {
        var CompilePipeline = function CompilePipeline(steps) {
          this._control = new CompileControl(steps);
        };
        return ($traceurRuntime.createClass)(CompilePipeline, {
          process: function(rootElement) {
            var compilationCtxtDescription = arguments[1] !== (void 0) ? arguments[1] : '';
            var results = ListWrapper.create();
            this._process(results, null, new CompileElement(rootElement, compilationCtxtDescription), compilationCtxtDescription);
            return results;
          },
          _process: function(results, parent, current) {
            var compilationCtxtDescription = arguments[3] !== (void 0) ? arguments[3] : '';
            var additionalChildren = this._control.internalProcess(results, 0, parent, current);
            if (current.compileChildren) {
              var node = DOM.firstChild(DOM.templateAwareRoot(current.element));
              while (isPresent(node)) {
                var nextNode = DOM.nextSibling(node);
                if (DOM.isElementNode(node)) {
                  this._process(results, current, new CompileElement(node, compilationCtxtDescription));
                }
                node = nextNode;
              }
            }
            if (isPresent(additionalChildren)) {
              for (var i = 0; i < additionalChildren.length; i++) {
                this._process(results, current, additionalChildren[i]);
              }
            }
          }
        }, {});
      }()));
      Object.defineProperty(CompilePipeline, "parameters", {get: function() {
          return [[assert.genericType(List, CompileStep)]];
        }});
      Object.defineProperty(CompilePipeline.prototype.process, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(CompilePipeline.prototype._process, "parameters", {get: function() {
          return [[], [CompileElement], [CompileElement], [assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/property_binding_parser", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/change_detection", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/property_binding_parser";
  var isPresent,
      isBlank,
      RegExpWrapper,
      BaseException,
      MapWrapper,
      Parser,
      AST,
      ExpressionWithSource,
      CompileStep,
      CompileElement,
      CompileControl,
      BIND_NAME_REGEXP,
      PropertyBindingParser;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      RegExpWrapper = $__m.RegExpWrapper;
      BaseException = $__m.BaseException;
    }, function($__m) {
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      Parser = $__m.Parser;
      AST = $__m.AST;
      ExpressionWithSource = $__m.ExpressionWithSource;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      BIND_NAME_REGEXP = RegExpWrapper.create('^(?:(?:(?:(bind)|(var)|(on))-(.+))|\\[([^\\]]+)\\]|\\(([^\\)]+)\\)|(#)(.+))$');
      PropertyBindingParser = $__export("PropertyBindingParser", (function($__super) {
        var PropertyBindingParser = function PropertyBindingParser(parser) {
          $traceurRuntime.superConstructor(PropertyBindingParser).call(this);
          this._parser = parser;
        };
        return ($traceurRuntime.createClass)(PropertyBindingParser, {
          process: function(parent, current, control) {
            var $__0 = this;
            if (current.ignoreBindings) {
              return ;
            }
            var attrs = current.attrs();
            var newAttrs = MapWrapper.create();
            var desc = current.elementDescription;
            MapWrapper.forEach(attrs, (function(attrValue, attrName) {
              var bindParts = RegExpWrapper.firstMatch(BIND_NAME_REGEXP, attrName);
              if (isPresent(bindParts)) {
                if (isPresent(bindParts[1])) {
                  current.addPropertyBinding(bindParts[4], $__0._parseBinding(attrValue, desc));
                  MapWrapper.set(newAttrs, bindParts[4], attrValue);
                } else if (isPresent(bindParts[2]) || isPresent(bindParts[7])) {
                  var identifier = (isPresent(bindParts[4]) && bindParts[4] !== '') ? bindParts[4] : bindParts[8];
                  var value = attrValue == '' ? '\$implicit' : attrValue;
                  current.addVariableBinding(identifier, value);
                  MapWrapper.set(newAttrs, identifier, value);
                } else if (isPresent(bindParts[3])) {
                  current.addEventBinding(bindParts[4], $__0._parseAction(attrValue, desc));
                } else if (isPresent(bindParts[5])) {
                  current.addPropertyBinding(bindParts[5], $__0._parseBinding(attrValue, desc));
                  MapWrapper.set(newAttrs, bindParts[5], attrValue);
                } else if (isPresent(bindParts[6])) {
                  current.addEventBinding(bindParts[6], $__0._parseAction(attrValue, desc));
                }
              } else {
                var ast = $__0._parseInterpolation(attrValue, desc);
                if (isPresent(ast)) {
                  current.addPropertyBinding(attrName, ast);
                } else {
                  current.addAttribute(attrName, attrValue);
                }
              }
            }));
            MapWrapper.forEach(newAttrs, (function(attrValue, attrName) {
              MapWrapper.set(attrs, attrName, attrValue);
            }));
          },
          _parseInterpolation: function(input, location) {
            return this._parser.parseInterpolation(input, location);
          },
          _parseBinding: function(input, location) {
            return this._parser.parseBinding(input, location);
          },
          _parseAction: function(input, location) {
            return this._parser.parseAction(input, location);
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(PropertyBindingParser, "parameters", {get: function() {
          return [[Parser]];
        }});
      Object.defineProperty(PropertyBindingParser.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      Object.defineProperty(PropertyBindingParser.prototype._parseInterpolation, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(PropertyBindingParser.prototype._parseBinding, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(PropertyBindingParser.prototype._parseAction, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/text_interpolation_parser", ["angular2/src/facade/lang", "angular2/src/dom/dom_adapter", "angular2/change_detection", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/text_interpolation_parser";
  var RegExpWrapper,
      StringWrapper,
      isPresent,
      DOM,
      Parser,
      CompileStep,
      CompileElement,
      CompileControl,
      TextInterpolationParser;
  return {
    setters: [function($__m) {
      RegExpWrapper = $__m.RegExpWrapper;
      StringWrapper = $__m.StringWrapper;
      isPresent = $__m.isPresent;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      Parser = $__m.Parser;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      TextInterpolationParser = $__export("TextInterpolationParser", (function($__super) {
        var TextInterpolationParser = function TextInterpolationParser(parser) {
          $traceurRuntime.superConstructor(TextInterpolationParser).call(this);
          this._parser = parser;
        };
        return ($traceurRuntime.createClass)(TextInterpolationParser, {
          process: function(parent, current, control) {
            if (!current.compileChildren || current.ignoreBindings) {
              return ;
            }
            var element = current.element;
            var childNodes = DOM.childNodes(DOM.templateAwareRoot(element));
            for (var i = 0; i < childNodes.length; i++) {
              var node = childNodes[i];
              if (DOM.isTextNode(node)) {
                this._parseTextNode(current, node, i);
              }
            }
          },
          _parseTextNode: function(pipelineElement, node, nodeIndex) {
            var ast = this._parser.parseInterpolation(DOM.nodeValue(node), pipelineElement.elementDescription);
            if (isPresent(ast)) {
              DOM.setText(node, ' ');
              pipelineElement.addTextNodeBinding(nodeIndex, ast);
            }
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(TextInterpolationParser, "parameters", {get: function() {
          return [[Parser]];
        }});
      Object.defineProperty(TextInterpolationParser.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/compiler/selector", ["angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/compiler/selector";
  var List,
      Map,
      ListWrapper,
      MapWrapper,
      isPresent,
      isBlank,
      RegExpWrapper,
      RegExpMatcherWrapper,
      StringWrapper,
      BaseException,
      _EMPTY_ATTR_VALUE,
      _SELECTOR_REGEXP,
      CssSelector,
      SelectorMatcher,
      SelectorListContext,
      SelectorContext;
  return {
    setters: [function($__m) {
      List = $__m.List;
      Map = $__m.Map;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      RegExpWrapper = $__m.RegExpWrapper;
      RegExpMatcherWrapper = $__m.RegExpMatcherWrapper;
      StringWrapper = $__m.StringWrapper;
      BaseException = $__m.BaseException;
    }],
    execute: function() {
      _EMPTY_ATTR_VALUE = '';
      _SELECTOR_REGEXP = RegExpWrapper.create('(\\:not\\()|' + '([-\\w]+)|' + '(?:\\.([-\\w]+))|' + '(?:\\[([-\\w*]+)(?:=([^\\]]*))?\\])|' + '(?:\\))|' + '(\\s*,\\s*)');
      CssSelector = $__export("CssSelector", (function() {
        var CssSelector = function CssSelector() {
          this.element = null;
          this.classNames = ListWrapper.create();
          this.attrs = ListWrapper.create();
          this.notSelector = null;
        };
        return ($traceurRuntime.createClass)(CssSelector, {
          setElement: function() {
            var element = arguments[0] !== (void 0) ? arguments[0] : null;
            if (isPresent(element)) {
              element = element.toLowerCase();
            }
            this.element = element;
          },
          addAttribute: function(name) {
            var value = arguments[1] !== (void 0) ? arguments[1] : _EMPTY_ATTR_VALUE;
            ListWrapper.push(this.attrs, name.toLowerCase());
            if (isPresent(value)) {
              value = value.toLowerCase();
            } else {
              value = _EMPTY_ATTR_VALUE;
            }
            ListWrapper.push(this.attrs, value);
          },
          addClassName: function(name) {
            ListWrapper.push(this.classNames, name.toLowerCase());
          },
          toString: function() {
            var res = '';
            if (isPresent(this.element)) {
              res += this.element;
            }
            if (isPresent(this.classNames)) {
              for (var i = 0; i < this.classNames.length; i++) {
                res += '.' + this.classNames[i];
              }
            }
            if (isPresent(this.attrs)) {
              for (var i = 0; i < this.attrs.length; ) {
                var attrName = this.attrs[i++];
                var attrValue = this.attrs[i++];
                res += '[' + attrName;
                if (attrValue.length > 0) {
                  res += '=' + attrValue;
                }
                res += ']';
              }
            }
            if (isPresent(this.notSelector)) {
              res += ":not(" + this.notSelector.toString() + ")";
            }
            return res;
          }
        }, {parse: function(selector) {
            var results = ListWrapper.create();
            var _addResult = (function(res, cssSel) {
              if (isPresent(cssSel.notSelector) && isBlank(cssSel.element) && ListWrapper.isEmpty(cssSel.classNames) && ListWrapper.isEmpty(cssSel.attrs)) {
                cssSel.element = "*";
              }
              ListWrapper.push(res, cssSel);
            });
            var cssSelector = new CssSelector();
            var matcher = RegExpWrapper.matcher(_SELECTOR_REGEXP, selector);
            var match;
            var current = cssSelector;
            while (isPresent(match = RegExpMatcherWrapper.next(matcher))) {
              if (isPresent(match[1])) {
                if (isPresent(cssSelector.notSelector)) {
                  throw new BaseException('Nesting :not is not allowed in a selector');
                }
                current.notSelector = new CssSelector();
                current = current.notSelector;
              }
              if (isPresent(match[2])) {
                current.setElement(match[2]);
              }
              if (isPresent(match[3])) {
                current.addClassName(match[3]);
              }
              if (isPresent(match[4])) {
                current.addAttribute(match[4], match[5]);
              }
              if (isPresent(match[6])) {
                _addResult(results, cssSelector);
                cssSelector = current = new CssSelector();
              }
            }
            _addResult(results, cssSelector);
            return results;
          }});
      }()));
      Object.defineProperty(CssSelector.parse, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(CssSelector.prototype.setElement, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(CssSelector.prototype.addAttribute, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(CssSelector.prototype.addClassName, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      SelectorMatcher = $__export("SelectorMatcher", (function() {
        var SelectorMatcher = function SelectorMatcher() {
          this._elementMap = MapWrapper.create();
          this._elementPartialMap = MapWrapper.create();
          this._classMap = MapWrapper.create();
          this._classPartialMap = MapWrapper.create();
          this._attrValueMap = MapWrapper.create();
          this._attrValuePartialMap = MapWrapper.create();
          this._listContexts = ListWrapper.create();
        };
        return ($traceurRuntime.createClass)(SelectorMatcher, {
          addSelectables: function(cssSelectors, callbackCtxt) {
            var listContext = null;
            if (cssSelectors.length > 1) {
              listContext = new SelectorListContext(cssSelectors);
              ListWrapper.push(this._listContexts, listContext);
            }
            for (var i = 0; i < cssSelectors.length; i++) {
              this.addSelectable(cssSelectors[i], callbackCtxt, listContext);
            }
          },
          addSelectable: function(cssSelector, callbackCtxt, listContext) {
            var matcher = this;
            var element = cssSelector.element;
            var classNames = cssSelector.classNames;
            var attrs = cssSelector.attrs;
            var selectable = new SelectorContext(cssSelector, callbackCtxt, listContext);
            if (isPresent(element)) {
              var isTerminal = attrs.length === 0 && classNames.length === 0;
              if (isTerminal) {
                this._addTerminal(matcher._elementMap, element, selectable);
              } else {
                matcher = this._addPartial(matcher._elementPartialMap, element);
              }
            }
            if (isPresent(classNames)) {
              for (var index = 0; index < classNames.length; index++) {
                var isTerminal = attrs.length === 0 && index === classNames.length - 1;
                var className = classNames[index];
                if (isTerminal) {
                  this._addTerminal(matcher._classMap, className, selectable);
                } else {
                  matcher = this._addPartial(matcher._classPartialMap, className);
                }
              }
            }
            if (isPresent(attrs)) {
              for (var index = 0; index < attrs.length; ) {
                var isTerminal = index === attrs.length - 2;
                var attrName = attrs[index++];
                var attrValue = attrs[index++];
                var map = isTerminal ? matcher._attrValueMap : matcher._attrValuePartialMap;
                var valuesMap = MapWrapper.get(map, attrName);
                if (isBlank(valuesMap)) {
                  valuesMap = MapWrapper.create();
                  MapWrapper.set(map, attrName, valuesMap);
                }
                if (isTerminal) {
                  this._addTerminal(valuesMap, attrValue, selectable);
                } else {
                  matcher = this._addPartial(valuesMap, attrValue);
                }
              }
            }
          },
          _addTerminal: function(map, name, selectable) {
            var terminalList = MapWrapper.get(map, name);
            if (isBlank(terminalList)) {
              terminalList = ListWrapper.create();
              MapWrapper.set(map, name, terminalList);
            }
            ListWrapper.push(terminalList, selectable);
          },
          _addPartial: function(map, name) {
            var matcher = MapWrapper.get(map, name);
            if (isBlank(matcher)) {
              matcher = new SelectorMatcher();
              MapWrapper.set(map, name, matcher);
            }
            return matcher;
          },
          match: function(cssSelector, matchedCallback) {
            var result = false;
            var element = cssSelector.element;
            var classNames = cssSelector.classNames;
            var attrs = cssSelector.attrs;
            for (var i = 0; i < this._listContexts.length; i++) {
              this._listContexts[i].alreadyMatched = false;
            }
            result = this._matchTerminal(this._elementMap, element, cssSelector, matchedCallback) || result;
            result = this._matchPartial(this._elementPartialMap, element, cssSelector, matchedCallback) || result;
            if (isPresent(classNames)) {
              for (var index = 0; index < classNames.length; index++) {
                var className = classNames[index];
                result = this._matchTerminal(this._classMap, className, cssSelector, matchedCallback) || result;
                result = this._matchPartial(this._classPartialMap, className, cssSelector, matchedCallback) || result;
              }
            }
            if (isPresent(attrs)) {
              for (var index = 0; index < attrs.length; ) {
                var attrName = attrs[index++];
                var attrValue = attrs[index++];
                var valuesMap = MapWrapper.get(this._attrValueMap, attrName);
                if (!StringWrapper.equals(attrValue, _EMPTY_ATTR_VALUE)) {
                  result = this._matchTerminal(valuesMap, _EMPTY_ATTR_VALUE, cssSelector, matchedCallback) || result;
                }
                result = this._matchTerminal(valuesMap, attrValue, cssSelector, matchedCallback) || result;
                valuesMap = MapWrapper.get(this._attrValuePartialMap, attrName);
                result = this._matchPartial(valuesMap, attrValue, cssSelector, matchedCallback) || result;
              }
            }
            return result;
          },
          _matchTerminal: function() {
            var map = arguments[0] !== (void 0) ? arguments[0] : null;
            var name = arguments[1];
            var cssSelector = arguments[2];
            var matchedCallback = arguments[3];
            if (isBlank(map) || isBlank(name)) {
              return false;
            }
            var selectables = MapWrapper.get(map, name);
            var starSelectables = MapWrapper.get(map, "*");
            if (isPresent(starSelectables)) {
              selectables = ListWrapper.concat(selectables, starSelectables);
            }
            if (isBlank(selectables)) {
              return false;
            }
            var selectable;
            var result = false;
            for (var index = 0; index < selectables.length; index++) {
              selectable = selectables[index];
              result = selectable.finalize(cssSelector, matchedCallback) || result;
            }
            return result;
          },
          _matchPartial: function() {
            var map = arguments[0] !== (void 0) ? arguments[0] : null;
            var name = arguments[1];
            var cssSelector = arguments[2];
            var matchedCallback = arguments[3];
            if (isBlank(map) || isBlank(name)) {
              return false;
            }
            var nestedSelector = MapWrapper.get(map, name);
            if (isBlank(nestedSelector)) {
              return false;
            }
            return nestedSelector.match(cssSelector, matchedCallback);
          }
        }, {});
      }()));
      Object.defineProperty(SelectorMatcher.prototype.addSelectables, "parameters", {get: function() {
          return [[assert.genericType(List, CssSelector)], []];
        }});
      Object.defineProperty(SelectorMatcher.prototype.addSelectable, "parameters", {get: function() {
          return [[], [], [SelectorListContext]];
        }});
      Object.defineProperty(SelectorMatcher.prototype._addTerminal, "parameters", {get: function() {
          return [[assert.genericType(Map, assert.type.string, assert.type.string)], [assert.type.string], []];
        }});
      Object.defineProperty(SelectorMatcher.prototype._addPartial, "parameters", {get: function() {
          return [[assert.genericType(Map, assert.type.string, assert.type.string)], [assert.type.string]];
        }});
      Object.defineProperty(SelectorMatcher.prototype.match, "parameters", {get: function() {
          return [[CssSelector], [Function]];
        }});
      Object.defineProperty(SelectorMatcher.prototype._matchTerminal, "parameters", {get: function() {
          return [[assert.genericType(Map, assert.type.string, assert.type.string)], [], [], []];
        }});
      Object.defineProperty(SelectorMatcher.prototype._matchPartial, "parameters", {get: function() {
          return [[assert.genericType(Map, assert.type.string, assert.type.string)], [], [], []];
        }});
      SelectorListContext = (function() {
        var SelectorListContext = function SelectorListContext(selectors) {
          this.selectors = selectors;
          this.alreadyMatched = false;
        };
        return ($traceurRuntime.createClass)(SelectorListContext, {}, {});
      }());
      Object.defineProperty(SelectorListContext, "parameters", {get: function() {
          return [[assert.genericType(List, CssSelector)]];
        }});
      SelectorContext = (function() {
        var SelectorContext = function SelectorContext(selector, cbContext, listContext) {
          this.selector = selector;
          this.notSelector = selector.notSelector;
          this.cbContext = cbContext;
          this.listContext = listContext;
        };
        return ($traceurRuntime.createClass)(SelectorContext, {finalize: function(cssSelector, callback) {
            var result = true;
            if (isPresent(this.notSelector) && (isBlank(this.listContext) || !this.listContext.alreadyMatched)) {
              var notMatcher = new SelectorMatcher();
              notMatcher.addSelectable(this.notSelector, null, null);
              result = !notMatcher.match(cssSelector, null);
            }
            if (result && isPresent(callback) && (isBlank(this.listContext) || !this.listContext.alreadyMatched)) {
              if (isPresent(this.listContext)) {
                this.listContext.alreadyMatched = true;
              }
              callback(this.selector, this.cbContext);
            }
            return result;
          }}, {});
      }());
      Object.defineProperty(SelectorContext, "parameters", {get: function() {
          return [[CssSelector], [], [SelectorListContext]];
        }});
      Object.defineProperty(SelectorContext.prototype.finalize, "parameters", {get: function() {
          return [[CssSelector], []];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/view_splitter", ["angular2/src/facade/lang", "angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/change_detection", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/view_splitter";
  var isBlank,
      isPresent,
      BaseException,
      DOM,
      MapWrapper,
      ListWrapper,
      Parser,
      CompileStep,
      CompileElement,
      CompileControl,
      StringWrapper,
      ViewSplitter;
  return {
    setters: [function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      StringWrapper = $__m.StringWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      MapWrapper = $__m.MapWrapper;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      Parser = $__m.Parser;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      ViewSplitter = $__export("ViewSplitter", (function($__super) {
        var ViewSplitter = function ViewSplitter(parser) {
          $traceurRuntime.superConstructor(ViewSplitter).call(this);
          this._parser = parser;
        };
        return ($traceurRuntime.createClass)(ViewSplitter, {
          process: function(parent, current, control) {
            var attrs = current.attrs();
            var templateBindings = MapWrapper.get(attrs, 'template');
            var hasTemplateBinding = isPresent(templateBindings);
            MapWrapper.forEach(attrs, (function(attrValue, attrName) {
              if (StringWrapper.startsWith(attrName, '*')) {
                var key = StringWrapper.substring(attrName, 1);
                if (hasTemplateBinding) {
                  throw new BaseException("Only one template directive per element is allowed: " + (templateBindings + " and " + key + " cannot be used simultaneously ") + ("in " + current.elementDescription));
                } else {
                  templateBindings = (attrValue.length == 0) ? key : key + ' ' + attrValue;
                  hasTemplateBinding = true;
                }
              }
            }));
            if (isBlank(parent)) {
              current.isViewRoot = true;
            } else {
              if (DOM.isTemplateElement(current.element)) {
                if (!current.isViewRoot) {
                  var viewRoot = new CompileElement(DOM.createTemplate(''));
                  var currentElement = current.element;
                  var viewRootElement = viewRoot.element;
                  this._moveChildNodes(DOM.content(currentElement), DOM.content(viewRootElement));
                  viewRoot.elementDescription = current.elementDescription;
                  viewRoot.isViewRoot = true;
                  control.addChild(viewRoot);
                }
              } else {
                if (hasTemplateBinding) {
                  var newParent = new CompileElement(DOM.createTemplate(''));
                  newParent.elementDescription = current.elementDescription;
                  current.isViewRoot = true;
                  this._parseTemplateBindings(templateBindings, newParent);
                  this._addParentElement(current.element, newParent.element);
                  control.addParent(newParent);
                  DOM.remove(current.element);
                }
              }
            }
          },
          _moveChildNodes: function(source, target) {
            var next = DOM.firstChild(source);
            while (isPresent(next)) {
              DOM.appendChild(target, next);
              next = DOM.firstChild(source);
            }
          },
          _addParentElement: function(currentElement, newParentElement) {
            DOM.insertBefore(currentElement, newParentElement);
            DOM.appendChild(newParentElement, currentElement);
          },
          _parseTemplateBindings: function(templateBindings, compileElement) {
            var bindings = this._parser.parseTemplateBindings(templateBindings, compileElement.elementDescription);
            for (var i = 0; i < bindings.length; i++) {
              var binding = bindings[i];
              if (binding.keyIsVar) {
                compileElement.addVariableBinding(binding.key, binding.name);
                MapWrapper.set(compileElement.attrs(), binding.key, binding.name);
              } else if (isPresent(binding.expression)) {
                compileElement.addPropertyBinding(binding.key, binding.expression);
                MapWrapper.set(compileElement.attrs(), binding.key, binding.expression.source);
              } else {
                DOM.setAttribute(compileElement.element, binding.key, '');
              }
            }
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(ViewSplitter, "parameters", {get: function() {
          return [[Parser]];
        }});
      Object.defineProperty(ViewSplitter.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      Object.defineProperty(ViewSplitter.prototype._parseTemplateBindings, "parameters", {get: function() {
          return [[assert.type.string], [CompileElement]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/element_binding_marker", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/element_binding_marker";
  var isPresent,
      MapWrapper,
      DOM,
      CompileStep,
      CompileElement,
      CompileControl,
      NG_BINDING_CLASS,
      ElementBindingMarker;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      NG_BINDING_CLASS = 'ng-binding';
      ElementBindingMarker = $__export("ElementBindingMarker", (function($__super) {
        var ElementBindingMarker = function ElementBindingMarker() {
          $traceurRuntime.superConstructor(ElementBindingMarker).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(ElementBindingMarker, {process: function(parent, current, control) {
            if (current.ignoreBindings) {
              return ;
            }
            var hasBindings = (isPresent(current.textNodeBindings) && MapWrapper.size(current.textNodeBindings) > 0) || (isPresent(current.propertyBindings) && MapWrapper.size(current.propertyBindings) > 0) || (isPresent(current.variableBindings) && MapWrapper.size(current.variableBindings) > 0) || (isPresent(current.eventBindings) && MapWrapper.size(current.eventBindings) > 0) || (isPresent(current.decoratorDirectives) && current.decoratorDirectives.length > 0) || isPresent(current.viewportDirective) || isPresent(current.componentDirective) || isPresent(current.contentTagSelector);
            if (hasBindings) {
              var element = current.element;
              DOM.addClass(element, NG_BINDING_CLASS);
              current.hasBindings = true;
            }
          }}, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(ElementBindingMarker.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/proto_view_builder", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/core/compiler/view", "angular2/change_detection", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/annotations/annotations"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/proto_view_builder";
  var isPresent,
      BaseException,
      ListWrapper,
      MapWrapper,
      ProtoView,
      ChangeDetection,
      CompileStep,
      CompileElement,
      CompileControl,
      ShadowDomStrategy,
      DirectiveMetadata,
      Component,
      ProtoViewBuilder;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      ProtoView = $__m.ProtoView;
    }, function($__m) {
      ChangeDetection = $__m.ChangeDetection;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      Component = $__m.Component;
    }],
    execute: function() {
      ProtoViewBuilder = $__export("ProtoViewBuilder", (function($__super) {
        var ProtoViewBuilder = function ProtoViewBuilder(compiledComponent, changeDetection, shadowDomStrategy) {
          $traceurRuntime.superConstructor(ProtoViewBuilder).call(this);
          this._compiledComponent = compiledComponent;
          this._shadowDomStrategy = shadowDomStrategy;
          this.changeDetection = changeDetection;
        };
        return ($traceurRuntime.createClass)(ProtoViewBuilder, {
          process: function(parent, current, control) {
            var inheritedProtoView = null;
            if (current.isViewRoot) {
              var componentAnnotation = this._compiledComponent.annotation;
              var protoChangeDetector = this.changeDetection.createProtoChangeDetector('dummy', componentAnnotation.changeDetection);
              inheritedProtoView = new ProtoView(current.element, protoChangeDetector, this._shadowDomStrategy, this._getParentProtoView(parent));
              if (isPresent(parent)) {
                if (isPresent(parent.inheritedElementBinder.nestedProtoView)) {
                  throw new BaseException('Only one nested view per element is allowed');
                }
                parent.inheritedElementBinder.nestedProtoView = inheritedProtoView;
                if (isPresent(parent.variableBindings)) {
                  MapWrapper.forEach(parent.variableBindings, (function(mappedName, varName) {
                    inheritedProtoView.bindVariable(varName, mappedName);
                  }));
                }
              }
            } else if (isPresent(parent)) {
              inheritedProtoView = parent.inheritedProtoView;
            }
            if (isPresent(current.variableBindings)) {
              MapWrapper.forEach(current.variableBindings, (function(mappedName, varName) {
                MapWrapper.set(inheritedProtoView.protoLocals, mappedName, null);
              }));
            }
            current.inheritedProtoView = inheritedProtoView;
          },
          _getParentProtoView: function(parent) {
            return isPresent(parent) ? parent.inheritedProtoView : null;
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(ProtoViewBuilder, "parameters", {get: function() {
          return [[DirectiveMetadata], [ChangeDetection], [ShadowDomStrategy]];
        }});
      Object.defineProperty(ProtoViewBuilder.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      Object.defineProperty(ProtoViewBuilder.prototype._getParentProtoView, "parameters", {get: function() {
          return [[CompileElement]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/proto_element_injector_builder", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/core/compiler/element_injector", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control", "angular2/src/core/compiler/directive_metadata"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/proto_element_injector_builder";
  var isPresent,
      isBlank,
      ListWrapper,
      MapWrapper,
      ProtoElementInjector,
      ComponentKeyMetaData,
      DirectiveBinding,
      CompileStep,
      CompileElement,
      CompileControl,
      DirectiveMetadata,
      ProtoElementInjectorBuilder;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      ProtoElementInjector = $__m.ProtoElementInjector;
      ComponentKeyMetaData = $__m.ComponentKeyMetaData;
      DirectiveBinding = $__m.DirectiveBinding;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }],
    execute: function() {
      ProtoElementInjectorBuilder = $__export("ProtoElementInjectorBuilder", (function($__super) {
        var ProtoElementInjectorBuilder = function ProtoElementInjectorBuilder() {
          $traceurRuntime.superConstructor(ProtoElementInjectorBuilder).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(ProtoElementInjectorBuilder, {
          internalCreateProtoElementInjector: function(parent, index, directives, firstBindingIsComponent, distance) {
            return new ProtoElementInjector(parent, index, directives, firstBindingIsComponent, distance);
          },
          process: function(parent, current, control) {
            var distanceToParentInjector = this._getDistanceToParentInjector(parent, current);
            var parentProtoElementInjector = this._getParentProtoElementInjector(parent, current);
            var injectorBindings = ListWrapper.map(current.getAllDirectives(), this._createBinding);
            if (injectorBindings.length > 0 || isPresent(current.variableBindings)) {
              var protoView = current.inheritedProtoView;
              var hasComponent = isPresent(current.componentDirective);
              current.inheritedProtoElementInjector = this.internalCreateProtoElementInjector(parentProtoElementInjector, protoView.elementBinders.length, injectorBindings, hasComponent, distanceToParentInjector);
              current.distanceToParentInjector = 0;
              if (isPresent(current.variableBindings) && !isPresent(current.viewportDirective)) {
                current.inheritedProtoElementInjector.exportComponent = hasComponent;
                current.inheritedProtoElementInjector.exportElement = !hasComponent;
                var exportImplicitName = MapWrapper.get(current.variableBindings, '\$implicit');
                if (isPresent(exportImplicitName)) {
                  current.inheritedProtoElementInjector.exportImplicitName = exportImplicitName;
                }
              }
              current.inheritedProtoElementInjector.attributes = current.attributes;
            } else {
              current.inheritedProtoElementInjector = parentProtoElementInjector;
              current.distanceToParentInjector = distanceToParentInjector;
            }
          },
          _getDistanceToParentInjector: function(parent, current) {
            return isPresent(parent) ? parent.distanceToParentInjector + 1 : 0;
          },
          _getParentProtoElementInjector: function(parent, current) {
            if (isPresent(parent) && !current.isViewRoot) {
              return parent.inheritedProtoElementInjector;
            }
            return null;
          },
          _createBinding: function(d) {
            return DirectiveBinding.createFromType(d.type, d.annotation);
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(ProtoElementInjectorBuilder.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      Object.defineProperty(ProtoElementInjectorBuilder.prototype._createBinding, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/element_binder_builder", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/reflection", "angular2/change_detection", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control", "angular2/src/core/compiler/string_utils", "angular2/src/render/dom/compiler/property_setter_factory"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/element_binder_builder";
  var int,
      isPresent,
      isBlank,
      ListWrapper,
      List,
      MapWrapper,
      StringMapWrapper,
      reflector,
      Parser,
      ProtoChangeDetector,
      DirectiveMetadata,
      CompileStep,
      CompileElement,
      CompileControl,
      dashCaseToCamelCase,
      setterFactory,
      ElementBinderBuilder;
  return {
    setters: [function($__m) {
      int = $__m.int;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      reflector = $__m.reflector;
    }, function($__m) {
      Parser = $__m.Parser;
      ProtoChangeDetector = $__m.ProtoChangeDetector;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }, function($__m) {
      dashCaseToCamelCase = $__m.dashCaseToCamelCase;
    }, function($__m) {
      setterFactory = $__m.setterFactory;
    }],
    execute: function() {
      ElementBinderBuilder = $__export("ElementBinderBuilder", (function($__super) {
        var ElementBinderBuilder = function ElementBinderBuilder(parser) {
          $traceurRuntime.superConstructor(ElementBinderBuilder).call(this);
          this._parser = parser;
        };
        return ($traceurRuntime.createClass)(ElementBinderBuilder, {
          process: function(parent, current, control) {
            var elementBinder = null;
            var parentElementBinder = null;
            var distanceToParentBinder = this._getDistanceToParentBinder(parent, current);
            if (isPresent(parent)) {
              parentElementBinder = parent.inheritedElementBinder;
            }
            if (current.hasBindings) {
              var protoView = current.inheritedProtoView;
              var protoInjectorWasBuilt = isBlank(parent) ? true : current.inheritedProtoElementInjector !== parent.inheritedProtoElementInjector;
              var currentProtoElementInjector = protoInjectorWasBuilt ? current.inheritedProtoElementInjector : null;
              elementBinder = protoView.bindElement(parentElementBinder, distanceToParentBinder, currentProtoElementInjector, current.componentDirective, current.viewportDirective);
              current.distanceToParentBinder = 0;
              if (isPresent(current.textNodeBindings)) {
                this._bindTextNodes(protoView, current);
              }
              if (isPresent(current.propertyBindings)) {
                this._bindElementProperties(protoView, current);
              }
              if (isPresent(current.eventBindings)) {
                this._bindEvents(protoView, current);
              }
              if (isPresent(current.contentTagSelector)) {
                elementBinder.contentTagSelector = current.contentTagSelector;
              }
              var directives = current.getAllDirectives();
              this._bindDirectiveProperties(directives, current);
              this._bindDirectiveEvents(directives, current);
            } else if (isPresent(parent)) {
              elementBinder = parentElementBinder;
              current.distanceToParentBinder = distanceToParentBinder;
            }
            current.inheritedElementBinder = elementBinder;
          },
          _getDistanceToParentBinder: function(parent, current) {
            return isPresent(parent) ? parent.distanceToParentBinder + 1 : 0;
          },
          _bindTextNodes: function(protoView, compileElement) {
            MapWrapper.forEach(compileElement.textNodeBindings, (function(expression, indexInParent) {
              protoView.bindTextNode(indexInParent, expression);
            }));
          },
          _bindElementProperties: function(protoView, compileElement) {
            MapWrapper.forEach(compileElement.propertyBindings, (function(expression, property) {
              var setterFn = setterFactory(property);
              protoView.bindElementProperty(expression.ast, property, setterFn);
            }));
          },
          _bindEvents: function(protoView, compileElement) {
            MapWrapper.forEach(compileElement.eventBindings, (function(expression, eventName) {
              protoView.bindEvent(eventName, expression);
            }));
          },
          _bindDirectiveEvents: function(directives, compileElement) {
            var $__0 = this;
            for (var directiveIndex = 0; directiveIndex < directives.length; directiveIndex++) {
              var directive = directives[directiveIndex];
              var annotation = directive.annotation;
              if (isBlank(annotation.events))
                continue;
              var protoView = compileElement.inheritedProtoView;
              StringMapWrapper.forEach(annotation.events, (function(action, eventName) {
                var expression = $__0._parser.parseAction(action, compileElement.elementDescription);
                protoView.bindEvent(eventName, expression, directiveIndex);
              }));
            }
          },
          _bindDirectiveProperties: function(directives, compileElement) {
            var $__0 = this;
            var protoView = compileElement.inheritedProtoView;
            for (var directiveIndex = 0; directiveIndex < directives.length; directiveIndex++) {
              var directive = ListWrapper.get(directives, directiveIndex);
              var annotation = directive.annotation;
              if (isBlank(annotation.bind))
                continue;
              StringMapWrapper.forEach(annotation.bind, (function(bindConfig, dirProp) {
                var pipes = $__0._splitBindConfig(bindConfig);
                var elProp = ListWrapper.removeAt(pipes, 0);
                var bindingAst = isPresent(compileElement.propertyBindings) ? MapWrapper.get(compileElement.propertyBindings, dashCaseToCamelCase(elProp)) : null;
                if (isBlank(bindingAst)) {
                  var attributeValue = MapWrapper.get(compileElement.attrs(), elProp);
                  if (isPresent(attributeValue)) {
                    bindingAst = $__0._parser.wrapLiteralPrimitive(attributeValue, compileElement.elementDescription);
                  }
                }
                if (isPresent(bindingAst)) {
                  var fullExpAstWithBindPipes = $__0._parser.addPipes(bindingAst, pipes);
                  protoView.bindDirectiveProperty(directiveIndex, fullExpAstWithBindPipes, dirProp, reflector.setter(dashCaseToCamelCase(dirProp)));
                }
              }));
            }
          },
          _splitBindConfig: function(bindConfig) {
            return ListWrapper.map(bindConfig.split('|'), (function(s) {
              return s.trim();
            }));
          }
        }, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(ElementBinderBuilder, "parameters", {get: function() {
          return [[Parser]];
        }});
      Object.defineProperty(ElementBinderBuilder.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      Object.defineProperty(ElementBinderBuilder.prototype._bindDirectiveEvents, "parameters", {get: function() {
          return [[assert.genericType(List, DirectiveMetadata)], [CompileElement]];
        }});
      Object.defineProperty(ElementBinderBuilder.prototype._bindDirectiveProperties, "parameters", {get: function() {
          return [[assert.genericType(List, DirectiveMetadata)], [CompileElement]];
        }});
      Object.defineProperty(ElementBinderBuilder.prototype._splitBindConfig, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/css_processor", ["angular2/di", "angular2/src/dom/dom_adapter", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/core/compiler/directive_metadata"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/css_processor";
  var Injectable,
      DOM,
      isPresent,
      List,
      CompileStep,
      CompileElement,
      CompileControl,
      ShadowDomStrategy,
      DirectiveMetadata,
      CssProcessor,
      CssTransformer,
      _CssProcessorStep;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }],
    execute: function() {
      CssProcessor = $__export("CssProcessor", (function() {
        var CssProcessor = function CssProcessor(transformers) {
          this._transformers = transformers;
        };
        return ($traceurRuntime.createClass)(CssProcessor, {getCompileStep: function(cmpMetadata, shadowDomStrategy, templateUrl) {
            var strategyStep = shadowDomStrategy.getStyleCompileStep(cmpMetadata, templateUrl);
            return new _CssProcessorStep(strategyStep, this._transformers);
          }}, {});
      }()));
      Object.defineProperty(CssProcessor, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(CssProcessor, "parameters", {get: function() {
          return [[assert.genericType(List, CssTransformer)]];
        }});
      Object.defineProperty(CssProcessor.prototype.getCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [ShadowDomStrategy], [assert.type.string]];
        }});
      CssTransformer = $__export("CssTransformer", (function() {
        var CssTransformer = function CssTransformer() {
          ;
        };
        return ($traceurRuntime.createClass)(CssTransformer, {transform: function(styleElement) {}}, {});
      }()));
      _CssProcessorStep = (function($__super) {
        var _CssProcessorStep = function _CssProcessorStep(strategyStep, transformers) {
          $traceurRuntime.superConstructor(_CssProcessorStep).call(this);
          this._strategyStep = strategyStep;
          this._transformers = transformers;
        };
        return ($traceurRuntime.createClass)(_CssProcessorStep, {process: function(parent, current, control) {
            if (DOM.tagName(current.element) == 'STYLE') {
              current.ignoreBindings = true;
              if (isPresent(this._transformers)) {
                var styleEl = current.element;
                for (var i = 0; i < this._transformers.length; i++) {
                  this._transformers[i].transform(styleEl);
                }
              }
              if (isPresent(this._strategyStep)) {
                this._strategyStep.process(parent, current, control);
              }
            }
          }}, {}, $__super);
      }(CompileStep));
      Object.defineProperty(_CssProcessorStep, "parameters", {get: function() {
          return [[CompileStep], [assert.genericType(List, CssTransformer)]];
        }});
      Object.defineProperty(_CssProcessorStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/template_loader", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/services/xhr", "angular2/src/core/annotations/template", "angular2/src/services/url_resolver"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/template_loader";
  var Injectable,
      isBlank,
      isPresent,
      BaseException,
      stringify,
      Map,
      MapWrapper,
      StringMapWrapper,
      StringMap,
      DOM,
      XHR,
      Template,
      UrlResolver,
      TemplateLoader;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      stringify = $__m.stringify;
    }, function($__m) {
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
      StringMap = $__m.StringMap;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      XHR = $__m.XHR;
    }, function($__m) {
      Template = $__m.Template;
    }, function($__m) {
      UrlResolver = $__m.UrlResolver;
    }],
    execute: function() {
      TemplateLoader = $__export("TemplateLoader", (function() {
        var TemplateLoader = function TemplateLoader(xhr, urlResolver) {
          this._xhr = xhr;
          this._urlResolver = urlResolver;
          this._htmlCache = StringMapWrapper.create();
          this._baseUrls = MapWrapper.create();
          this._urlCache = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(TemplateLoader, {
          load: function(template) {
            if (isPresent(template.inline)) {
              return DOM.createTemplate(template.inline);
            }
            if (isPresent(template.url)) {
              var url = this.getTemplateUrl(template);
              var promise = StringMapWrapper.get(this._htmlCache, url);
              if (isBlank(promise)) {
                promise = this._xhr.get(url).then(function(html) {
                  var template = DOM.createTemplate(html);
                  return template;
                });
                StringMapWrapper.set(this._htmlCache, url, promise);
              }
              return promise;
            }
            throw new BaseException('Templates should have either their url or inline property set');
          },
          setBaseUrl: function(template, baseUrl) {
            MapWrapper.set(this._baseUrls, template, baseUrl);
            MapWrapper.delete(this._urlCache, template);
          },
          getTemplateUrl: function(template) {
            if (!MapWrapper.contains(this._urlCache, template)) {
              var baseUrl = MapWrapper.get(this._baseUrls, template);
              if (isBlank(baseUrl)) {
                throw new BaseException('The template base URL is not set');
              }
              var templateUrl;
              if (isPresent(template.url)) {
                templateUrl = this._urlResolver.resolve(baseUrl, template.url);
              } else {
                templateUrl = baseUrl;
              }
              MapWrapper.set(this._urlCache, template, templateUrl);
            }
            return MapWrapper.get(this._urlCache, template);
          }
        }, {});
      }()));
      Object.defineProperty(TemplateLoader, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(TemplateLoader, "parameters", {get: function() {
          return [[XHR], [UrlResolver]];
        }});
      Object.defineProperty(TemplateLoader.prototype.load, "parameters", {get: function() {
          return [[Template]];
        }});
      Object.defineProperty(TemplateLoader.prototype.setBaseUrl, "parameters", {get: function() {
          return [[Template], [assert.type.string]];
        }});
      Object.defineProperty(TemplateLoader.prototype.getTemplateUrl, "parameters", {get: function() {
          return [[Template]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/template_resolver", ["angular2/di", "angular2/src/core/annotations/template", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/reflection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/template_resolver";
  var Injectable,
      Template,
      Type,
      stringify,
      isBlank,
      BaseException,
      Map,
      MapWrapper,
      List,
      ListWrapper,
      reflector,
      TemplateResolver;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Template = $__m.Template;
    }, function($__m) {
      Type = $__m.Type;
      stringify = $__m.stringify;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
    }, function($__m) {
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      reflector = $__m.reflector;
    }],
    execute: function() {
      TemplateResolver = $__export("TemplateResolver", (function() {
        var TemplateResolver = function TemplateResolver() {
          this._cache = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(TemplateResolver, {
          resolve: function(component) {
            var template = MapWrapper.get(this._cache, component);
            if (isBlank(template)) {
              template = this._resolve(component);
              MapWrapper.set(this._cache, component, template);
            }
            return template;
          },
          _resolve: function(component) {
            var annotations = reflector.annotations(component);
            for (var i = 0; i < annotations.length; i++) {
              var annotation = annotations[i];
              if (annotation instanceof Template) {
                return annotation;
              }
            }
            throw new BaseException(("No template found for " + stringify(component)));
          }
        }, {});
      }()));
      Object.defineProperty(TemplateResolver, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(TemplateResolver.prototype.resolve, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(TemplateResolver.prototype._resolve, "parameters", {get: function() {
          return [[Type]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/component_url_mapper", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/component_url_mapper";
  var Injectable,
      Type,
      isPresent,
      Map,
      MapWrapper,
      ComponentUrlMapper,
      RuntimeComponentUrlMapper;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Type = $__m.Type;
      isPresent = $__m.isPresent;
    }, function($__m) {
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
    }],
    execute: function() {
      ComponentUrlMapper = $__export("ComponentUrlMapper", (function() {
        var ComponentUrlMapper = function ComponentUrlMapper() {
          ;
        };
        return ($traceurRuntime.createClass)(ComponentUrlMapper, {getUrl: function(component) {
            return './';
          }}, {});
      }()));
      Object.defineProperty(ComponentUrlMapper, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(ComponentUrlMapper.prototype.getUrl, "parameters", {get: function() {
          return [[Type]];
        }});
      RuntimeComponentUrlMapper = $__export("RuntimeComponentUrlMapper", (function($__super) {
        var RuntimeComponentUrlMapper = function RuntimeComponentUrlMapper() {
          $traceurRuntime.superConstructor(RuntimeComponentUrlMapper).call(this);
          this._componentUrls = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(RuntimeComponentUrlMapper, {
          setComponentUrl: function(component, url) {
            MapWrapper.set(this._componentUrls, component, url);
          },
          getUrl: function(component) {
            var url = MapWrapper.get(this._componentUrls, component);
            if (isPresent(url))
              return url;
            return $traceurRuntime.superGet(this, RuntimeComponentUrlMapper.prototype, "getUrl").call(this, component);
          }
        }, {}, $__super);
      }(ComponentUrlMapper)));
      Object.defineProperty(RuntimeComponentUrlMapper.prototype.setComponentUrl, "parameters", {get: function() {
          return [[Type], [assert.type.string]];
        }});
      Object.defineProperty(RuntimeComponentUrlMapper.prototype.getUrl, "parameters", {get: function() {
          return [[Type]];
        }});
    }
  };
});

System.register("angular2/src/core/exception_handler", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/exception_handler";
  var Injectable,
      isPresent,
      print,
      ListWrapper,
      isListLikeIterable,
      ExceptionHandler;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      isPresent = $__m.isPresent;
      print = $__m.print;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      isListLikeIterable = $__m.isListLikeIterable;
    }],
    execute: function() {
      ExceptionHandler = $__export("ExceptionHandler", (function() {
        var ExceptionHandler = function ExceptionHandler() {
          ;
        };
        return ($traceurRuntime.createClass)(ExceptionHandler, {call: function(error) {
            var stackTrace = arguments[1] !== (void 0) ? arguments[1] : null;
            var reason = arguments[2] !== (void 0) ? arguments[2] : null;
            var longStackTrace = isListLikeIterable(stackTrace) ? ListWrapper.join(stackTrace, "\n\n") : stackTrace;
            var reasonStr = isPresent(reason) ? ("\n" + reason) : '';
            print(("" + error + reasonStr + "\nSTACKTRACE:\n" + longStackTrace));
          }}, {});
      }()));
      Object.defineProperty(ExceptionHandler, "annotations", {get: function() {
          return [new Injectable()];
        }});
    }
  };
});

System.register("angular2/src/core/life_cycle/life_cycle", ["angular2/di", "angular2/change_detection", "angular2/src/core/zone/vm_turn_zone", "angular2/src/core/exception_handler", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/life_cycle/life_cycle";
  var Injectable,
      ChangeDetector,
      VmTurnZone,
      ExceptionHandler,
      isPresent,
      LifeCycle;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      ChangeDetector = $__m.ChangeDetector;
    }, function($__m) {
      VmTurnZone = $__m.VmTurnZone;
    }, function($__m) {
      ExceptionHandler = $__m.ExceptionHandler;
    }, function($__m) {
      isPresent = $__m.isPresent;
    }],
    execute: function() {
      LifeCycle = $__export("LifeCycle", (function() {
        var LifeCycle = function LifeCycle(exceptionHandler) {
          var changeDetector = arguments[1] !== (void 0) ? arguments[1] : null;
          var enforceNoNewChanges = arguments[2] !== (void 0) ? arguments[2] : false;
          this._errorHandler = (function(exception, stackTrace) {
            exceptionHandler.call(exception, stackTrace);
            throw exception;
          });
          this._changeDetector = changeDetector;
          this._enforceNoNewChanges = enforceNoNewChanges;
        };
        return ($traceurRuntime.createClass)(LifeCycle, {
          registerWith: function(zone) {
            var changeDetector = arguments[1] !== (void 0) ? arguments[1] : null;
            var $__0 = this;
            if (isPresent(changeDetector)) {
              this._changeDetector = changeDetector;
            }
            zone.initCallbacks({
              onErrorHandler: this._errorHandler,
              onTurnDone: (function() {
                return $__0.tick();
              })
            });
          },
          tick: function() {
            this._changeDetector.detectChanges();
            if (this._enforceNoNewChanges) {
              this._changeDetector.checkNoChanges();
            }
          }
        }, {});
      }()));
      Object.defineProperty(LifeCycle, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(LifeCycle, "parameters", {get: function() {
          return [[ExceptionHandler], [ChangeDetector], [assert.type.boolean]];
        }});
      Object.defineProperty(LifeCycle.prototype.registerWith, "parameters", {get: function() {
          return [[VmTurnZone], [ChangeDetector]];
        }});
    }
  };
});

System.register("angular2/src/services/xhr_impl", ["angular2/di", "angular2/src/facade/async", "angular2/src/services/xhr"], function($__export) {
  "";
  var __moduleName = "angular2/src/services/xhr_impl";
  var Injectable,
      Promise,
      PromiseWrapper,
      XHR,
      XHRImpl;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Promise = $__m.Promise;
      PromiseWrapper = $__m.PromiseWrapper;
    }, function($__m) {
      XHR = $__m.XHR;
    }],
    execute: function() {
      XHRImpl = $__export("XHRImpl", (function($__super) {
        var XHRImpl = function XHRImpl() {
          $traceurRuntime.superConstructor(XHRImpl).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(XHRImpl, {get: function(url) {
            var completer = PromiseWrapper.completer();
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'text';
            xhr.onload = function() {
              var status = xhr.status;
              if (200 <= status && status <= 300) {
                completer.resolve(xhr.responseText);
              } else {
                completer.reject(("Failed to load " + url));
              }
            };
            xhr.onerror = function() {
              completer.reject(("Failed to load " + url));
            };
            xhr.send();
            return completer.promise;
          }}, {}, $__super);
      }(XHR)));
      Object.defineProperty(XHRImpl, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(XHRImpl.prototype.get, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/events/hammer_common", ["angular2/src/render/dom/events/event_manager", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/events/hammer_common";
  var EventManagerPlugin,
      StringMapWrapper,
      _eventNames,
      HammerGesturesPluginCommon;
  return {
    setters: [function($__m) {
      EventManagerPlugin = $__m.EventManagerPlugin;
    }, function($__m) {
      StringMapWrapper = $__m.StringMapWrapper;
    }],
    execute: function() {
      _eventNames = {
        'pan': true,
        'panstart': true,
        'panmove': true,
        'panend': true,
        'pancancel': true,
        'panleft': true,
        'panright': true,
        'panup': true,
        'pandown': true,
        'pinch': true,
        'pinchstart': true,
        'pinchmove': true,
        'pinchend': true,
        'pinchcancel': true,
        'pinchin': true,
        'pinchout': true,
        'press': true,
        'pressup': true,
        'rotate': true,
        'rotatestart': true,
        'rotatemove': true,
        'rotateend': true,
        'rotatecancel': true,
        'swipe': true,
        'swipeleft': true,
        'swiperight': true,
        'swipeup': true,
        'swipedown': true,
        'tap': true
      };
      HammerGesturesPluginCommon = $__export("HammerGesturesPluginCommon", (function($__super) {
        var HammerGesturesPluginCommon = function HammerGesturesPluginCommon() {
          $traceurRuntime.superConstructor(HammerGesturesPluginCommon).call(this);
        };
        return ($traceurRuntime.createClass)(HammerGesturesPluginCommon, {supports: function(eventName) {
            eventName = eventName.toLowerCase();
            return StringMapWrapper.contains(_eventNames, eventName);
          }}, {}, $__super);
      }(EventManagerPlugin)));
      Object.defineProperty(HammerGesturesPluginCommon.prototype.supports, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/private_component_loader", ["angular2/src/core/compiler/compiler", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/di", "angular2/src/render/dom/events/event_manager", "angular2/src/core/compiler/directive_metadata_reader", "angular2/src/core/annotations/annotations", "angular2/src/core/compiler/private_component_location", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/private_component_loader";
  var Compiler,
      ShadowDomStrategy,
      Injectable,
      EventManager,
      DirectiveMetadataReader,
      Component,
      PrivateComponentLocation,
      Type,
      stringify,
      BaseException,
      PrivateComponentLoader;
  return {
    setters: [function($__m) {
      Compiler = $__m.Compiler;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      EventManager = $__m.EventManager;
    }, function($__m) {
      DirectiveMetadataReader = $__m.DirectiveMetadataReader;
    }, function($__m) {
      Component = $__m.Component;
    }, function($__m) {
      PrivateComponentLocation = $__m.PrivateComponentLocation;
    }, function($__m) {
      Type = $__m.Type;
      stringify = $__m.stringify;
      BaseException = $__m.BaseException;
    }],
    execute: function() {
      PrivateComponentLoader = $__export("PrivateComponentLoader", (function() {
        var PrivateComponentLoader = function PrivateComponentLoader(compiler, shadowDomStrategy, eventManager, directiveMetadataReader) {
          this.compiler = compiler;
          this.shadowDomStrategy = shadowDomStrategy;
          this.eventManager = eventManager;
          this.directiveMetadataReader = directiveMetadataReader;
        };
        return ($traceurRuntime.createClass)(PrivateComponentLoader, {load: function(type, location) {
            var $__0 = this;
            var annotation = this.directiveMetadataReader.read(type).annotation;
            if (!(annotation instanceof Component)) {
              throw new BaseException(("Could not load '" + stringify(type) + "' because it is not a component."));
            }
            return this.compiler.compile(type).then((function(componentProtoView) {
              location.createComponent(type, annotation, componentProtoView, $__0.eventManager, $__0.shadowDomStrategy);
            }));
          }}, {});
      }()));
      Object.defineProperty(PrivateComponentLoader, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(PrivateComponentLoader, "parameters", {get: function() {
          return [[Compiler], [ShadowDomStrategy], [EventManager], [DirectiveMetadataReader]];
        }});
      Object.defineProperty(PrivateComponentLoader.prototype.load, "parameters", {get: function() {
          return [[Type], [PrivateComponentLocation]];
        }});
    }
  };
});

System.register("angular2/src/core/testability/get_testability", ["angular2/src/core/testability/testability"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/testability/get_testability";
  var TestabilityRegistry,
      Testability,
      PublicTestability,
      GetTestability;
  return {
    setters: [function($__m) {
      TestabilityRegistry = $__m.TestabilityRegistry;
      Testability = $__m.Testability;
    }],
    execute: function() {
      PublicTestability = (function() {
        var PublicTestability = function PublicTestability(testability) {
          this._testability = testability;
        };
        return ($traceurRuntime.createClass)(PublicTestability, {
          whenStable: function(callback) {
            this._testability.whenStable(callback);
          },
          findBindings: function(using, binding, exactMatch) {
            return this._testability.findBindings(using, binding, exactMatch);
          }
        }, {});
      }());
      Object.defineProperty(PublicTestability, "parameters", {get: function() {
          return [[Testability]];
        }});
      Object.defineProperty(PublicTestability.prototype.whenStable, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(PublicTestability.prototype.findBindings, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.boolean]];
        }});
      GetTestability = $__export("GetTestability", (function() {
        var GetTestability = function GetTestability() {
          ;
        };
        return ($traceurRuntime.createClass)(GetTestability, {}, {addToWindow: function(registry) {
            if (!window.angular2) {
              window.angular2 = {};
            }
            window.angular2.getTestability = function(elem) {
              var testability = registry.findTestabilityInTree(elem);
              if (testability == null) {
                throw new Error('Could not find testability for element.');
              }
              return new PublicTestability(testability);
            };
            window.angular2.resumeBootstrap = function() {};
          }});
      }()));
      Object.defineProperty(GetTestability.addToWindow, "parameters", {get: function() {
          return [[TestabilityRegistry]];
        }});
    }
  };
});

System.register("angular2/annotations", ["angular2/src/core/annotations/annotations"], function($__export) {
  "";
  var __moduleName = "angular2/annotations";
  var $__exportNames = {};
  return {
    setters: [function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }],
    execute: function() {}
  };
});

System.register("angular2/src/directives/for", ["angular2/src/core/annotations/annotations", "angular2/src/core/compiler/view_container", "angular2/src/core/compiler/view", "angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/directives/for";
  var Viewport,
      ViewContainer,
      View,
      isPresent,
      isBlank,
      ListWrapper,
      For,
      RecordViewTuple;
  return {
    setters: [function($__m) {
      Viewport = $__m.Viewport;
    }, function($__m) {
      ViewContainer = $__m.ViewContainer;
    }, function($__m) {
      View = $__m.View;
    }, function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
    }],
    execute: function() {
      For = $__export("For", (function() {
        var For = function For(viewContainer) {
          this.viewContainer = viewContainer;
        };
        return ($traceurRuntime.createClass)(For, {
          set iterableChanges(changes) {
            if (isBlank(changes)) {
              this.viewContainer.clear();
              return ;
            }
            var recordViewTuples = [];
            changes.forEachRemovedItem((function(removedRecord) {
              return ListWrapper.push(recordViewTuples, new RecordViewTuple(removedRecord, null));
            }));
            changes.forEachMovedItem((function(movedRecord) {
              return ListWrapper.push(recordViewTuples, new RecordViewTuple(movedRecord, null));
            }));
            var insertTuples = For.bulkRemove(recordViewTuples, this.viewContainer);
            changes.forEachAddedItem((function(addedRecord) {
              return ListWrapper.push(insertTuples, new RecordViewTuple(addedRecord, null));
            }));
            For.bulkInsert(insertTuples, this.viewContainer);
            for (var i = 0; i < insertTuples.length; i++) {
              this.perViewChange(insertTuples[i].view, insertTuples[i].record);
            }
          },
          perViewChange: function(view, record) {
            view.setLocal('\$implicit', record.item);
            view.setLocal('index', record.currentIndex);
          }
        }, {
          bulkRemove: function(tuples, viewContainer) {
            tuples.sort((function(a, b) {
              return a.record.previousIndex - b.record.previousIndex;
            }));
            var movedTuples = [];
            for (var i = tuples.length - 1; i >= 0; i--) {
              var tuple = tuples[i];
              if (isPresent(tuple.record.currentIndex)) {
                tuple.view = viewContainer.detach(tuple.record.previousIndex);
                ListWrapper.push(movedTuples, tuple);
              } else {
                viewContainer.remove(tuple.record.previousIndex);
              }
            }
            return movedTuples;
          },
          bulkInsert: function(tuples, viewContainer) {
            tuples.sort((function(a, b) {
              return a.record.currentIndex - b.record.currentIndex;
            }));
            for (var i = 0; i < tuples.length; i++) {
              var tuple = tuples[i];
              if (isPresent(tuple.view)) {
                viewContainer.insert(tuple.view, tuple.record.currentIndex);
              } else {
                tuple.view = viewContainer.create(tuple.record.currentIndex);
              }
            }
            return tuples;
          }
        });
      }()));
      Object.defineProperty(For, "annotations", {get: function() {
          return [new Viewport({
            selector: '[for][of]',
            bind: {'iterableChanges': 'of | iterableDiff'}
          })];
        }});
      Object.defineProperty(For, "parameters", {get: function() {
          return [[ViewContainer]];
        }});
      RecordViewTuple = (function() {
        var RecordViewTuple = function RecordViewTuple(record, view) {
          this.record = record;
          this.view = view;
        };
        return ($traceurRuntime.createClass)(RecordViewTuple, {}, {});
      }());
    }
  };
});

System.register("angular2/src/directives/if", ["angular2/src/core/annotations/annotations", "angular2/src/core/compiler/view_container", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/directives/if";
  var Viewport,
      ViewContainer,
      isBlank,
      If;
  return {
    setters: [function($__m) {
      Viewport = $__m.Viewport;
    }, function($__m) {
      ViewContainer = $__m.ViewContainer;
    }, function($__m) {
      isBlank = $__m.isBlank;
    }],
    execute: function() {
      If = $__export("If", (function() {
        var If = function If(viewContainer) {
          this.viewContainer = viewContainer;
          this.prevCondition = null;
        };
        return ($traceurRuntime.createClass)(If, {set condition(newCondition) {
            if (newCondition && (isBlank(this.prevCondition) || !this.prevCondition)) {
              this.prevCondition = true;
              this.viewContainer.create();
            } else if (!newCondition && (isBlank(this.prevCondition) || this.prevCondition)) {
              this.prevCondition = false;
              this.viewContainer.clear();
            }
          }}, {});
      }()));
      Object.defineProperty(If, "annotations", {get: function() {
          return [new Viewport({
            selector: '[if]',
            bind: {'condition': 'if'}
          })];
        }});
      Object.defineProperty(If, "parameters", {get: function() {
          return [[ViewContainer]];
        }});
    }
  };
});

System.register("angular2/src/directives/non_bindable", ["angular2/src/core/annotations/annotations"], function($__export) {
  "";
  var __moduleName = "angular2/src/directives/non_bindable";
  var Decorator,
      NonBindable;
  return {
    setters: [function($__m) {
      Decorator = $__m.Decorator;
    }],
    execute: function() {
      NonBindable = $__export("NonBindable", (function() {
        var NonBindable = function NonBindable() {
          ;
        };
        return ($traceurRuntime.createClass)(NonBindable, {}, {});
      }()));
      Object.defineProperty(NonBindable, "annotations", {get: function() {
          return [new Decorator({
            selector: '[non-bindable]',
            compileChildren: false
          })];
        }});
    }
  };
});

System.register("angular2/src/directives/switch", ["angular2/src/core/annotations/annotations", "angular2/src/core/compiler/view_container", "angular2/src/core/dom/element", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/core/annotations/visibility"], function($__export) {
  "";
  var __moduleName = "angular2/src/directives/switch";
  var Decorator,
      Viewport,
      ViewContainer,
      NgElement,
      isPresent,
      isBlank,
      normalizeBlank,
      ListWrapper,
      List,
      MapWrapper,
      Map,
      Parent,
      Switch,
      SwitchWhen,
      SwitchDefault,
      _whenDefault;
  return {
    setters: [function($__m) {
      Decorator = $__m.Decorator;
      Viewport = $__m.Viewport;
    }, function($__m) {
      ViewContainer = $__m.ViewContainer;
    }, function($__m) {
      NgElement = $__m.NgElement;
    }, function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      normalizeBlank = $__m.normalizeBlank;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
      Map = $__m.Map;
    }, function($__m) {
      Parent = $__m.Parent;
    }],
    execute: function() {
      Switch = $__export("Switch", (function() {
        var Switch = function Switch() {
          this._valueViewContainers = MapWrapper.create();
          this._activeViewContainers = ListWrapper.create();
          this._useDefault = false;
        };
        return ($traceurRuntime.createClass)(Switch, {
          set value(value) {
            this._emptyAllActiveViewContainers();
            this._useDefault = false;
            var containers = MapWrapper.get(this._valueViewContainers, value);
            if (isBlank(containers)) {
              this._useDefault = true;
              containers = normalizeBlank(MapWrapper.get(this._valueViewContainers, _whenDefault));
            }
            this._activateViewContainers(containers);
            this._switchValue = value;
          },
          _onWhenValueChanged: function(oldWhen, newWhen, viewContainer) {
            this._deregisterViewContainer(oldWhen, viewContainer);
            this._registerViewContainer(newWhen, viewContainer);
            if (oldWhen === this._switchValue) {
              viewContainer.remove();
              ListWrapper.remove(this._activeViewContainers, viewContainer);
            } else if (newWhen === this._switchValue) {
              if (this._useDefault) {
                this._useDefault = false;
                this._emptyAllActiveViewContainers();
              }
              viewContainer.create();
              ListWrapper.push(this._activeViewContainers, viewContainer);
            }
            if (this._activeViewContainers.length === 0 && !this._useDefault) {
              this._useDefault = true;
              this._activateViewContainers(MapWrapper.get(this._valueViewContainers, _whenDefault));
            }
          },
          _emptyAllActiveViewContainers: function() {
            var activeContainers = this._activeViewContainers;
            for (var i = 0; i < activeContainers.length; i++) {
              activeContainers[i].remove();
            }
            this._activeViewContainers = ListWrapper.create();
          },
          _activateViewContainers: function(containers) {
            if (isPresent(containers)) {
              for (var i = 0; i < containers.length; i++) {
                containers[i].create();
              }
              this._activeViewContainers = containers;
            }
          },
          _registerViewContainer: function(value, container) {
            var containers = MapWrapper.get(this._valueViewContainers, value);
            if (isBlank(containers)) {
              containers = ListWrapper.create();
              MapWrapper.set(this._valueViewContainers, value, containers);
            }
            ListWrapper.push(containers, container);
          },
          _deregisterViewContainer: function(value, container) {
            if (value == _whenDefault)
              return ;
            var containers = MapWrapper.get(this._valueViewContainers, value);
            if (containers.length == 1) {
              MapWrapper.delete(this._valueViewContainers, value);
            } else {
              ListWrapper.remove(containers, container);
            }
          }
        }, {});
      }()));
      Object.defineProperty(Switch, "annotations", {get: function() {
          return [new Decorator({
            selector: '[switch]',
            bind: {'value': 'switch'}
          })];
        }});
      Object.defineProperty(Switch.prototype._onWhenValueChanged, "parameters", {get: function() {
          return [[], [], [ViewContainer]];
        }});
      Object.defineProperty(Switch.prototype._activateViewContainers, "parameters", {get: function() {
          return [[assert.genericType(List, ViewContainer)]];
        }});
      Object.defineProperty(Switch.prototype._registerViewContainer, "parameters", {get: function() {
          return [[], [ViewContainer]];
        }});
      Object.defineProperty(Switch.prototype._deregisterViewContainer, "parameters", {get: function() {
          return [[], [ViewContainer]];
        }});
      SwitchWhen = $__export("SwitchWhen", (function() {
        var SwitchWhen = function SwitchWhen(el, viewContainer, sswitch) {
          this._value = _whenDefault;
          this._switch = sswitch;
          this._viewContainer = viewContainer;
        };
        return ($traceurRuntime.createClass)(SwitchWhen, {set when(value) {
            this._switch._onWhenValueChanged(this._value, value, this._viewContainer);
            this._value = value;
          }}, {});
      }()));
      Object.defineProperty(SwitchWhen, "annotations", {get: function() {
          return [new Viewport({
            selector: '[switch-when]',
            bind: {'when': 'switch-when'}
          })];
        }});
      Object.defineProperty(SwitchWhen, "parameters", {get: function() {
          return [[NgElement], [ViewContainer], [Switch, new Parent()]];
        }});
      SwitchDefault = $__export("SwitchDefault", (function() {
        var SwitchDefault = function SwitchDefault(viewContainer, sswitch) {
          sswitch._registerViewContainer(_whenDefault, viewContainer);
        };
        return ($traceurRuntime.createClass)(SwitchDefault, {}, {});
      }()));
      Object.defineProperty(SwitchDefault, "annotations", {get: function() {
          return [new Viewport({selector: '[switch-default]'})];
        }});
      Object.defineProperty(SwitchDefault, "parameters", {get: function() {
          return [[ViewContainer], [Switch, new Parent()]];
        }});
      _whenDefault = new Object();
    }
  };
});

System.register("angular2/src/forms/validators", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/forms/model"], function($__export) {
  "";
  var __moduleName = "angular2/src/forms/validators";
  var isBlank,
      isPresent,
      List,
      ListWrapper,
      StringMapWrapper,
      modelModule,
      Validators;
  return {
    setters: [function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      modelModule = $__m;
    }],
    execute: function() {
      Validators = $__export("Validators", (function() {
        var Validators = function Validators() {
          ;
        };
        return ($traceurRuntime.createClass)(Validators, {}, {
          required: function(c) {
            return isBlank(c.value) || c.value == "" ? {"required": true} : null;
          },
          nullValidator: function(c) {
            return null;
          },
          compose: function(validators) {
            return function(c) {
              var res = ListWrapper.reduce(validators, (function(res, validator) {
                var errors = validator(c);
                return isPresent(errors) ? StringMapWrapper.merge(res, errors) : res;
              }), {});
              return StringMapWrapper.isEmpty(res) ? null : res;
            };
          },
          group: function(c) {
            var res = {};
            StringMapWrapper.forEach(c.controls, (function(control, name) {
              if (c.contains(name) && isPresent(control.errors)) {
                Validators._mergeErrors(control, res);
              }
            }));
            return StringMapWrapper.isEmpty(res) ? null : res;
          },
          array: function(c) {
            var res = {};
            ListWrapper.forEach(c.controls, (function(control) {
              if (isPresent(control.errors)) {
                Validators._mergeErrors(control, res);
              }
            }));
            return StringMapWrapper.isEmpty(res) ? null : res;
          },
          _mergeErrors: function(control, res) {
            StringMapWrapper.forEach(control.errors, (function(value, error) {
              if (!StringMapWrapper.contains(res, error)) {
                res[error] = [];
              }
              ListWrapper.push(res[error], control);
            }));
          }
        });
      }()));
      Object.defineProperty(Validators.required, "parameters", {get: function() {
          return [[modelModule.Control]];
        }});
      Object.defineProperty(Validators.nullValidator, "parameters", {get: function() {
          return [[assert.type.any]];
        }});
      Object.defineProperty(Validators.compose, "parameters", {get: function() {
          return [[assert.genericType(List, Function)]];
        }});
      Object.defineProperty(Validators.group, "parameters", {get: function() {
          return [[modelModule.ControlGroup]];
        }});
      Object.defineProperty(Validators.array, "parameters", {get: function() {
          return [[modelModule.ControlArray]];
        }});
    }
  };
});

System.register("angular2/src/forms/directives", ["angular2/angular2", "angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/forms/model", "angular2/src/forms/validators"], function($__export) {
  "";
  var __moduleName = "angular2/src/forms/directives";
  var Template,
      Component,
      Decorator,
      Ancestor,
      onChange,
      PropertySetter,
      Optional,
      isBlank,
      isPresent,
      isString,
      CONST,
      StringMapWrapper,
      ListWrapper,
      ControlGroup,
      Control,
      Validators,
      DefaultValueAccessor,
      CheckboxControlValueAccessor,
      ControlDirective,
      ControlGroupDirective,
      FormDirectives;
  return {
    setters: [function($__m) {
      Template = $__m.Template;
      Component = $__m.Component;
      Decorator = $__m.Decorator;
      Ancestor = $__m.Ancestor;
      onChange = $__m.onChange;
      PropertySetter = $__m.PropertySetter;
    }, function($__m) {
      Optional = $__m.Optional;
    }, function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      isString = $__m.isString;
      CONST = $__m.CONST;
    }, function($__m) {
      StringMapWrapper = $__m.StringMapWrapper;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      ControlGroup = $__m.ControlGroup;
      Control = $__m.Control;
    }, function($__m) {
      Validators = $__m.Validators;
    }],
    execute: function() {
      DefaultValueAccessor = $__export("DefaultValueAccessor", (function() {
        var DefaultValueAccessor = function DefaultValueAccessor(setValueProperty) {
          this._setValueProperty = setValueProperty;
          this.onChange = (function(_) {});
        };
        return ($traceurRuntime.createClass)(DefaultValueAccessor, {writeValue: function(value) {
            this._setValueProperty(value);
          }}, {});
      }()));
      Object.defineProperty(DefaultValueAccessor, "annotations", {get: function() {
          return [new Decorator({
            selector: '[control]',
            events: {
              'change': 'onChange($event.target.value)',
              'input': 'onChange($event.target.value)'
            }
          })];
        }});
      Object.defineProperty(DefaultValueAccessor, "parameters", {get: function() {
          return [[Function, new PropertySetter('value')]];
        }});
      CheckboxControlValueAccessor = $__export("CheckboxControlValueAccessor", (function() {
        var CheckboxControlValueAccessor = function CheckboxControlValueAccessor(cd, setCheckedProperty) {
          this._setCheckedProperty = setCheckedProperty;
          this.onChange = (function(_) {});
          cd.valueAccessor = this;
        };
        return ($traceurRuntime.createClass)(CheckboxControlValueAccessor, {writeValue: function(value) {
            this._setCheckedProperty(value);
          }}, {});
      }()));
      Object.defineProperty(CheckboxControlValueAccessor, "annotations", {get: function() {
          return [new Decorator({
            selector: 'input[type=checkbox][control]',
            events: {'change': 'onChange($event.target.checked)'}
          })];
        }});
      Object.defineProperty(CheckboxControlValueAccessor, "parameters", {get: function() {
          return [[ControlDirective], [Function, new PropertySetter('checked')]];
        }});
      ControlDirective = $__export("ControlDirective", (function() {
        var ControlDirective = function ControlDirective(groupDirective, valueAccessor) {
          this._groupDirective = groupDirective;
          this.controlOrName = null;
          this.valueAccessor = valueAccessor;
          this.validator = Validators.nullValidator;
        };
        return ($traceurRuntime.createClass)(ControlDirective, {
          onChange: function(_) {
            this._initialize();
          },
          _initialize: function() {
            if (isPresent(this._groupDirective)) {
              this._groupDirective.addDirective(this);
            }
            var c = this._control();
            c.validator = Validators.compose([c.validator, this.validator]);
            this._updateDomValue();
            this._setUpUpdateControlValue();
          },
          _updateDomValue: function() {
            this.valueAccessor.writeValue(this._control().value);
          },
          _setUpUpdateControlValue: function() {
            var $__0 = this;
            this.valueAccessor.onChange = (function(newValue) {
              return $__0._control().updateValue(newValue);
            });
          },
          _control: function() {
            if (isString(this.controlOrName)) {
              return this._groupDirective.findControl(this.controlOrName);
            } else {
              return this.controlOrName;
            }
          }
        }, {});
      }()));
      Object.defineProperty(ControlDirective, "annotations", {get: function() {
          return [new Decorator({
            lifecycle: [onChange],
            selector: '[control]',
            bind: {'controlOrName': 'control'}
          })];
        }});
      Object.defineProperty(ControlDirective, "parameters", {get: function() {
          return [[ControlGroupDirective, new Optional(), new Ancestor()], [DefaultValueAccessor]];
        }});
      ControlGroupDirective = $__export("ControlGroupDirective", (function() {
        var ControlGroupDirective = function ControlGroupDirective(groupDirective) {
          this._groupDirective = groupDirective;
          this._directives = ListWrapper.create();
        };
        return ($traceurRuntime.createClass)(ControlGroupDirective, {
          set controlGroup(controlGroup) {
            if (isString(controlGroup)) {
              this._controlGroupName = controlGroup;
            } else {
              this._controlGroup = controlGroup;
            }
            this._updateDomValue();
          },
          _updateDomValue: function() {
            ListWrapper.forEach(this._directives, (function(cd) {
              return cd._updateDomValue();
            }));
          },
          addDirective: function(c) {
            ListWrapper.push(this._directives, c);
          },
          findControl: function(name) {
            return this._getControlGroup().controls[name];
          },
          _getControlGroup: function() {
            if (isPresent(this._controlGroupName)) {
              return this._groupDirective.findControl(this._controlGroupName);
            } else {
              return this._controlGroup;
            }
          }
        }, {});
      }()));
      Object.defineProperty(ControlGroupDirective, "annotations", {get: function() {
          return [new Decorator({
            selector: '[control-group]',
            bind: {'controlGroup': 'control-group'}
          })];
        }});
      Object.defineProperty(ControlGroupDirective, "parameters", {get: function() {
          return [[ControlGroupDirective, new Optional(), new Ancestor()]];
        }});
      Object.defineProperty(ControlGroupDirective.prototype.addDirective, "parameters", {get: function() {
          return [[ControlDirective]];
        }});
      Object.defineProperty(ControlGroupDirective.prototype.findControl, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      FormDirectives = $__export("FormDirectives", [ControlGroupDirective, ControlDirective, CheckboxControlValueAccessor, DefaultValueAccessor]);
    }
  };
});

System.register("angular2/src/forms/validator_directives", ["angular2/angular2", "angular2/forms"], function($__export) {
  "";
  var __moduleName = "angular2/src/forms/validator_directives";
  var Decorator,
      ControlDirective,
      Validators,
      RequiredValidatorDirective;
  return {
    setters: [function($__m) {
      Decorator = $__m.Decorator;
    }, function($__m) {
      ControlDirective = $__m.ControlDirective;
      Validators = $__m.Validators;
    }],
    execute: function() {
      RequiredValidatorDirective = $__export("RequiredValidatorDirective", (function() {
        var RequiredValidatorDirective = function RequiredValidatorDirective(c) {
          c.validator = Validators.compose([c.validator, Validators.required]);
        };
        return ($traceurRuntime.createClass)(RequiredValidatorDirective, {}, {});
      }()));
      Object.defineProperty(RequiredValidatorDirective, "annotations", {get: function() {
          return [new Decorator({selector: '[required]'})];
        }});
      Object.defineProperty(RequiredValidatorDirective, "parameters", {get: function() {
          return [[ControlDirective]];
        }});
    }
  };
});

System.register("angular2/src/forms/form_builder", ["angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/forms/model"], function($__export) {
  "";
  var __moduleName = "angular2/src/forms/form_builder";
  var StringMapWrapper,
      ListWrapper,
      List,
      isPresent,
      modelModule,
      FormBuilder;
  return {
    setters: [function($__m) {
      StringMapWrapper = $__m.StringMapWrapper;
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
    }, function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      modelModule = $__m;
    }],
    execute: function() {
      FormBuilder = $__export("FormBuilder", (function() {
        var FormBuilder = function FormBuilder() {
          ;
        };
        return ($traceurRuntime.createClass)(FormBuilder, {
          group: function(controlsConfig) {
            var extra = arguments[1] !== (void 0) ? arguments[1] : null;
            var controls = this._reduceControls(controlsConfig);
            var optionals = isPresent(extra) ? StringMapWrapper.get(extra, "optionals") : null;
            var validator = isPresent(extra) ? StringMapWrapper.get(extra, "validator") : null;
            if (isPresent(validator)) {
              return new modelModule.ControlGroup(controls, optionals, validator);
            } else {
              return new modelModule.ControlGroup(controls, optionals);
            }
          },
          control: function(value) {
            var validator = arguments[1] !== (void 0) ? arguments[1] : null;
            if (isPresent(validator)) {
              return new modelModule.Control(value, validator);
            } else {
              return new modelModule.Control(value);
            }
          },
          array: function(controlsConfig) {
            var validator = arguments[1] !== (void 0) ? arguments[1] : null;
            var $__0 = this;
            var controls = ListWrapper.map(controlsConfig, (function(c) {
              return $__0._createControl(c);
            }));
            if (isPresent(validator)) {
              return new modelModule.ControlArray(controls, validator);
            } else {
              return new modelModule.ControlArray(controls);
            }
          },
          _reduceControls: function(controlsConfig) {
            var $__0 = this;
            var controls = {};
            StringMapWrapper.forEach(controlsConfig, (function(controlConfig, controlName) {
              controls[controlName] = $__0._createControl(controlConfig);
            }));
            return controls;
          },
          _createControl: function(controlConfig) {
            if (controlConfig instanceof modelModule.Control || controlConfig instanceof modelModule.ControlGroup || controlConfig instanceof modelModule.ControlArray) {
              return controlConfig;
            } else if (ListWrapper.isList(controlConfig)) {
              var value = ListWrapper.get(controlConfig, 0);
              var validator = controlConfig.length > 1 ? controlConfig[1] : null;
              return this.control(value, validator);
            } else {
              return this.control(controlConfig);
            }
          }
        }, {});
      }()));
      Object.defineProperty(FormBuilder.prototype.control, "parameters", {get: function() {
          return [[], [Function]];
        }});
      Object.defineProperty(FormBuilder.prototype.array, "parameters", {get: function() {
          return [[List], [Function]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/parser/ast", ["angular2/src/facade/lang", "angular2/src/facade/collection"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/parser/ast";
  var autoConvertAdd,
      isBlank,
      isPresent,
      FunctionWrapper,
      BaseException,
      List,
      Map,
      ListWrapper,
      StringMapWrapper,
      AST,
      EmptyExpr,
      ImplicitReceiver,
      Chain,
      Conditional,
      AccessMember,
      KeyedAccess,
      Pipe,
      LiteralPrimitive,
      LiteralArray,
      LiteralMap,
      Interpolation,
      Binary,
      PrefixNot,
      Assignment,
      MethodCall,
      FunctionCall,
      ASTWithSource,
      TemplateBinding,
      AstVisitor,
      AstTransformer,
      _evalListCache;
  function evalList(context, locals, exps) {
    var length = exps.length;
    if (length > 10) {
      throw new BaseException("Cannot have more than 10 argument");
    }
    var result = _evalListCache[length];
    for (var i = 0; i < length; i++) {
      result[i] = exps[i].eval(context, locals);
    }
    return result;
  }
  return {
    setters: [function($__m) {
      autoConvertAdd = $__m.autoConvertAdd;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      FunctionWrapper = $__m.FunctionWrapper;
      BaseException = $__m.BaseException;
    }, function($__m) {
      List = $__m.List;
      Map = $__m.Map;
      ListWrapper = $__m.ListWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }],
    execute: function() {
      AST = $__export("AST", (function() {
        var AST = function AST() {
          ;
        };
        return ($traceurRuntime.createClass)(AST, {
          eval: function(context, locals) {
            throw new BaseException("Not supported");
          },
          get isAssignable() {
            return false;
          },
          assign: function(context, locals, value) {
            throw new BaseException("Not supported");
          },
          visit: function(visitor) {},
          toString: function() {
            return "AST";
          }
        }, {});
      }()));
      EmptyExpr = $__export("EmptyExpr", (function($__super) {
        var EmptyExpr = function EmptyExpr() {
          $traceurRuntime.superConstructor(EmptyExpr).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(EmptyExpr, {
          eval: function(context, locals) {
            return null;
          },
          visit: function(visitor) {}
        }, {}, $__super);
      }(AST)));
      ImplicitReceiver = $__export("ImplicitReceiver", (function($__super) {
        var ImplicitReceiver = function ImplicitReceiver() {
          $traceurRuntime.superConstructor(ImplicitReceiver).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(ImplicitReceiver, {
          eval: function(context, locals) {
            return context;
          },
          visit: function(visitor) {
            return visitor.visitImplicitReceiver(this);
          }
        }, {}, $__super);
      }(AST)));
      Chain = $__export("Chain", (function($__super) {
        var Chain = function Chain(expressions) {
          $traceurRuntime.superConstructor(Chain).call(this);
          this.expressions = expressions;
        };
        return ($traceurRuntime.createClass)(Chain, {
          eval: function(context, locals) {
            var result;
            for (var i = 0; i < this.expressions.length; i++) {
              var last = this.expressions[i].eval(context, locals);
              if (isPresent(last))
                result = last;
            }
            return result;
          },
          visit: function(visitor) {
            return visitor.visitChain(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(Chain, "parameters", {get: function() {
          return [[List]];
        }});
      Conditional = $__export("Conditional", (function($__super) {
        var Conditional = function Conditional(condition, trueExp, falseExp) {
          $traceurRuntime.superConstructor(Conditional).call(this);
          this.condition = condition;
          this.trueExp = trueExp;
          this.falseExp = falseExp;
        };
        return ($traceurRuntime.createClass)(Conditional, {
          eval: function(context, locals) {
            if (this.condition.eval(context, locals)) {
              return this.trueExp.eval(context, locals);
            } else {
              return this.falseExp.eval(context, locals);
            }
          },
          visit: function(visitor) {
            return visitor.visitConditional(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(Conditional, "parameters", {get: function() {
          return [[AST], [AST], [AST]];
        }});
      AccessMember = $__export("AccessMember", (function($__super) {
        var AccessMember = function AccessMember(receiver, name, getter, setter) {
          $traceurRuntime.superConstructor(AccessMember).call(this);
          this.receiver = receiver;
          this.name = name;
          this.getter = getter;
          this.setter = setter;
        };
        return ($traceurRuntime.createClass)(AccessMember, {
          eval: function(context, locals) {
            if (this.receiver instanceof ImplicitReceiver && isPresent(locals) && locals.contains(this.name)) {
              return locals.get(this.name);
            } else {
              var evaluatedReceiver = this.receiver.eval(context, locals);
              return this.getter(evaluatedReceiver);
            }
          },
          get isAssignable() {
            return true;
          },
          assign: function(context, locals, value) {
            var evaluatedContext = this.receiver.eval(context, locals);
            if (this.receiver instanceof ImplicitReceiver && isPresent(locals) && locals.contains(this.name)) {
              throw new BaseException(("Cannot reassign a variable binding " + this.name));
            } else {
              return this.setter(evaluatedContext, value);
            }
          },
          visit: function(visitor) {
            return visitor.visitAccessMember(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(AccessMember, "parameters", {get: function() {
          return [[AST], [assert.type.string], [Function], [Function]];
        }});
      KeyedAccess = $__export("KeyedAccess", (function($__super) {
        var KeyedAccess = function KeyedAccess(obj, key) {
          $traceurRuntime.superConstructor(KeyedAccess).call(this);
          this.obj = obj;
          this.key = key;
        };
        return ($traceurRuntime.createClass)(KeyedAccess, {
          eval: function(context, locals) {
            var obj = this.obj.eval(context, locals);
            var key = this.key.eval(context, locals);
            return obj[key];
          },
          get isAssignable() {
            return true;
          },
          assign: function(context, locals, value) {
            var obj = this.obj.eval(context, locals);
            var key = this.key.eval(context, locals);
            obj[key] = value;
            return value;
          },
          visit: function(visitor) {
            return visitor.visitKeyedAccess(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(KeyedAccess, "parameters", {get: function() {
          return [[AST], [AST]];
        }});
      Pipe = $__export("Pipe", (function($__super) {
        var Pipe = function Pipe(exp, name, args, inBinding) {
          $traceurRuntime.superConstructor(Pipe).call(this);
          this.exp = exp;
          this.name = name;
          this.args = args;
          this.inBinding = inBinding;
        };
        return ($traceurRuntime.createClass)(Pipe, {visit: function(visitor) {
            return visitor.visitPipe(this);
          }}, {}, $__super);
      }(AST)));
      Object.defineProperty(Pipe, "parameters", {get: function() {
          return [[AST], [assert.type.string], [List], [assert.type.boolean]];
        }});
      LiteralPrimitive = $__export("LiteralPrimitive", (function($__super) {
        var LiteralPrimitive = function LiteralPrimitive(value) {
          $traceurRuntime.superConstructor(LiteralPrimitive).call(this);
          this.value = value;
        };
        return ($traceurRuntime.createClass)(LiteralPrimitive, {
          eval: function(context, locals) {
            return this.value;
          },
          visit: function(visitor) {
            return visitor.visitLiteralPrimitive(this);
          }
        }, {}, $__super);
      }(AST)));
      LiteralArray = $__export("LiteralArray", (function($__super) {
        var LiteralArray = function LiteralArray(expressions) {
          $traceurRuntime.superConstructor(LiteralArray).call(this);
          this.expressions = expressions;
        };
        return ($traceurRuntime.createClass)(LiteralArray, {
          eval: function(context, locals) {
            return ListWrapper.map(this.expressions, (function(e) {
              return e.eval(context, locals);
            }));
          },
          visit: function(visitor) {
            return visitor.visitLiteralArray(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(LiteralArray, "parameters", {get: function() {
          return [[List]];
        }});
      LiteralMap = $__export("LiteralMap", (function($__super) {
        var LiteralMap = function LiteralMap(keys, values) {
          $traceurRuntime.superConstructor(LiteralMap).call(this);
          this.keys = keys;
          this.values = values;
        };
        return ($traceurRuntime.createClass)(LiteralMap, {
          eval: function(context, locals) {
            var res = StringMapWrapper.create();
            for (var i = 0; i < this.keys.length; ++i) {
              StringMapWrapper.set(res, this.keys[i], this.values[i].eval(context, locals));
            }
            return res;
          },
          visit: function(visitor) {
            return visitor.visitLiteralMap(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(LiteralMap, "parameters", {get: function() {
          return [[List], [List]];
        }});
      Interpolation = $__export("Interpolation", (function($__super) {
        var Interpolation = function Interpolation(strings, expressions) {
          $traceurRuntime.superConstructor(Interpolation).call(this);
          this.strings = strings;
          this.expressions = expressions;
        };
        return ($traceurRuntime.createClass)(Interpolation, {
          eval: function(context, locals) {
            throw new BaseException("evaluating an Interpolation is not supported");
          },
          visit: function(visitor) {
            visitor.visitInterpolation(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(Interpolation, "parameters", {get: function() {
          return [[List], [List]];
        }});
      Binary = $__export("Binary", (function($__super) {
        var Binary = function Binary(operation, left, right) {
          $traceurRuntime.superConstructor(Binary).call(this);
          this.operation = operation;
          this.left = left;
          this.right = right;
        };
        return ($traceurRuntime.createClass)(Binary, {
          eval: function(context, locals) {
            var left = this.left.eval(context, locals);
            switch (this.operation) {
              case '&&':
                return left && this.right.eval(context, locals);
              case '||':
                return left || this.right.eval(context, locals);
            }
            var right = this.right.eval(context, locals);
            switch (this.operation) {
              case '+':
                return left + right;
              case '-':
                return left - right;
              case '*':
                return left * right;
              case '/':
                return left / right;
              case '%':
                return left % right;
              case '==':
                return left == right;
              case '!=':
                return left != right;
              case '<':
                return left < right;
              case '>':
                return left > right;
              case '<=':
                return left <= right;
              case '>=':
                return left >= right;
              case '^':
                return left ^ right;
              case '&':
                return left & right;
            }
            throw 'Internal error [$operation] not handled';
          },
          visit: function(visitor) {
            return visitor.visitBinary(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(Binary, "parameters", {get: function() {
          return [[assert.type.string], [AST], [AST]];
        }});
      PrefixNot = $__export("PrefixNot", (function($__super) {
        var PrefixNot = function PrefixNot(expression) {
          $traceurRuntime.superConstructor(PrefixNot).call(this);
          this.expression = expression;
        };
        return ($traceurRuntime.createClass)(PrefixNot, {
          eval: function(context, locals) {
            return !this.expression.eval(context, locals);
          },
          visit: function(visitor) {
            return visitor.visitPrefixNot(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(PrefixNot, "parameters", {get: function() {
          return [[AST]];
        }});
      Assignment = $__export("Assignment", (function($__super) {
        var Assignment = function Assignment(target, value) {
          $traceurRuntime.superConstructor(Assignment).call(this);
          this.target = target;
          this.value = value;
        };
        return ($traceurRuntime.createClass)(Assignment, {
          eval: function(context, locals) {
            return this.target.assign(context, locals, this.value.eval(context, locals));
          },
          visit: function(visitor) {
            return visitor.visitAssignment(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(Assignment, "parameters", {get: function() {
          return [[AST], [AST]];
        }});
      MethodCall = $__export("MethodCall", (function($__super) {
        var MethodCall = function MethodCall(receiver, name, fn, args) {
          $traceurRuntime.superConstructor(MethodCall).call(this);
          this.receiver = receiver;
          this.fn = fn;
          this.args = args;
          this.name = name;
        };
        return ($traceurRuntime.createClass)(MethodCall, {
          eval: function(context, locals) {
            var evaluatedArgs = evalList(context, locals, this.args);
            if (this.receiver instanceof ImplicitReceiver && isPresent(locals) && locals.contains(this.name)) {
              var fn = locals.get(this.name);
              return FunctionWrapper.apply(fn, evaluatedArgs);
            } else {
              var evaluatedReceiver = this.receiver.eval(context, locals);
              return this.fn(evaluatedReceiver, evaluatedArgs);
            }
          },
          visit: function(visitor) {
            return visitor.visitMethodCall(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(MethodCall, "parameters", {get: function() {
          return [[AST], [assert.type.string], [Function], [List]];
        }});
      FunctionCall = $__export("FunctionCall", (function($__super) {
        var FunctionCall = function FunctionCall(target, args) {
          $traceurRuntime.superConstructor(FunctionCall).call(this);
          this.target = target;
          this.args = args;
        };
        return ($traceurRuntime.createClass)(FunctionCall, {
          eval: function(context, locals) {
            var obj = this.target.eval(context, locals);
            if (!(obj instanceof Function)) {
              throw new BaseException((obj + " is not a function"));
            }
            return FunctionWrapper.apply(obj, evalList(context, locals, this.args));
          },
          visit: function(visitor) {
            return visitor.visitFunctionCall(this);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(FunctionCall, "parameters", {get: function() {
          return [[AST], [List]];
        }});
      ASTWithSource = $__export("ASTWithSource", (function($__super) {
        var ASTWithSource = function ASTWithSource(ast, source, location) {
          $traceurRuntime.superConstructor(ASTWithSource).call(this);
          this.source = source;
          this.location = location;
          this.ast = ast;
        };
        return ($traceurRuntime.createClass)(ASTWithSource, {
          eval: function(context, locals) {
            return this.ast.eval(context, locals);
          },
          get isAssignable() {
            return this.ast.isAssignable;
          },
          assign: function(context, locals, value) {
            return this.ast.assign(context, locals, value);
          },
          visit: function(visitor) {
            return this.ast.visit(visitor);
          },
          toString: function() {
            return (this.source + " in " + this.location);
          }
        }, {}, $__super);
      }(AST)));
      Object.defineProperty(ASTWithSource, "parameters", {get: function() {
          return [[AST], [assert.type.string], [assert.type.string]];
        }});
      TemplateBinding = $__export("TemplateBinding", (function() {
        var TemplateBinding = function TemplateBinding(key, keyIsVar, name, expression) {
          this.key = key;
          this.keyIsVar = keyIsVar;
          this.name = name;
          this.expression = expression;
        };
        return ($traceurRuntime.createClass)(TemplateBinding, {}, {});
      }()));
      Object.defineProperty(TemplateBinding, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.boolean], [assert.type.string], [ASTWithSource]];
        }});
      AstVisitor = $__export("AstVisitor", (function() {
        var AstVisitor = function AstVisitor() {
          ;
        };
        return ($traceurRuntime.createClass)(AstVisitor, {
          visitAccessMember: function(ast) {},
          visitAssignment: function(ast) {},
          visitBinary: function(ast) {},
          visitChain: function(ast) {},
          visitConditional: function(ast) {},
          visitPipe: function(ast) {},
          visitFunctionCall: function(ast) {},
          visitImplicitReceiver: function(ast) {},
          visitKeyedAccess: function(ast) {},
          visitLiteralArray: function(ast) {},
          visitLiteralMap: function(ast) {},
          visitLiteralPrimitive: function(ast) {},
          visitMethodCall: function(ast) {},
          visitPrefixNot: function(ast) {}
        }, {});
      }()));
      Object.defineProperty(AstVisitor.prototype.visitAccessMember, "parameters", {get: function() {
          return [[AccessMember]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitAssignment, "parameters", {get: function() {
          return [[Assignment]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitBinary, "parameters", {get: function() {
          return [[Binary]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitChain, "parameters", {get: function() {
          return [[Chain]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitConditional, "parameters", {get: function() {
          return [[Conditional]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitPipe, "parameters", {get: function() {
          return [[Pipe]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitFunctionCall, "parameters", {get: function() {
          return [[FunctionCall]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitImplicitReceiver, "parameters", {get: function() {
          return [[ImplicitReceiver]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitKeyedAccess, "parameters", {get: function() {
          return [[KeyedAccess]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitLiteralArray, "parameters", {get: function() {
          return [[LiteralArray]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitLiteralMap, "parameters", {get: function() {
          return [[LiteralMap]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitLiteralPrimitive, "parameters", {get: function() {
          return [[LiteralPrimitive]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitMethodCall, "parameters", {get: function() {
          return [[MethodCall]];
        }});
      Object.defineProperty(AstVisitor.prototype.visitPrefixNot, "parameters", {get: function() {
          return [[PrefixNot]];
        }});
      AstTransformer = $__export("AstTransformer", (function() {
        var AstTransformer = function AstTransformer() {
          ;
        };
        return ($traceurRuntime.createClass)(AstTransformer, {
          visitImplicitReceiver: function(ast) {
            return new ImplicitReceiver();
          },
          visitInterpolation: function(ast) {
            return new Interpolation(ast.strings, this.visitAll(ast.expressions));
          },
          visitLiteralPrimitive: function(ast) {
            return new LiteralPrimitive(ast.value);
          },
          visitAccessMember: function(ast) {
            return new AccessMember(ast.receiver.visit(this), ast.name, ast.getter, ast.setter);
          },
          visitMethodCall: function(ast) {
            return new MethodCall(ast.receiver.visit(this), ast.name, ast.fn, this.visitAll(ast.args));
          },
          visitFunctionCall: function(ast) {
            return new FunctionCall(ast.target.visit(this), this.visitAll(ast.args));
          },
          visitLiteralArray: function(ast) {
            return new LiteralArray(this.visitAll(ast.expressions));
          },
          visitLiteralMap: function(ast) {
            return new LiteralMap(ast.keys, this.visitAll(ast.values));
          },
          visitBinary: function(ast) {
            return new Binary(ast.operation, ast.left.visit(this), ast.right.visit(this));
          },
          visitPrefixNot: function(ast) {
            return new PrefixNot(ast.expression.visit(this));
          },
          visitConditional: function(ast) {
            return new Conditional(ast.condition.visit(this), ast.trueExp.visit(this), ast.falseExp.visit(this));
          },
          visitPipe: function(ast) {
            return new Pipe(ast.exp.visit(this), ast.name, this.visitAll(ast.args), ast.inBinding);
          },
          visitKeyedAccess: function(ast) {
            return new KeyedAccess(ast.obj.visit(this), ast.key.visit(this));
          },
          visitAll: function(asts) {
            var res = ListWrapper.createFixedSize(asts.length);
            for (var i = 0; i < asts.length; ++i) {
              res[i] = asts[i].visit(this);
            }
            return res;
          }
        }, {});
      }()));
      Object.defineProperty(AstTransformer.prototype.visitImplicitReceiver, "parameters", {get: function() {
          return [[ImplicitReceiver]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitInterpolation, "parameters", {get: function() {
          return [[Interpolation]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitLiteralPrimitive, "parameters", {get: function() {
          return [[LiteralPrimitive]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitAccessMember, "parameters", {get: function() {
          return [[AccessMember]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitMethodCall, "parameters", {get: function() {
          return [[MethodCall]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitFunctionCall, "parameters", {get: function() {
          return [[FunctionCall]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitLiteralArray, "parameters", {get: function() {
          return [[LiteralArray]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitLiteralMap, "parameters", {get: function() {
          return [[LiteralMap]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitBinary, "parameters", {get: function() {
          return [[Binary]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitPrefixNot, "parameters", {get: function() {
          return [[PrefixNot]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitConditional, "parameters", {get: function() {
          return [[Conditional]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitPipe, "parameters", {get: function() {
          return [[Pipe]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitKeyedAccess, "parameters", {get: function() {
          return [[KeyedAccess]];
        }});
      Object.defineProperty(AstTransformer.prototype.visitAll, "parameters", {get: function() {
          return [[List]];
        }});
      _evalListCache = [[], [0], [0, 0], [0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]];
      Object.defineProperty(evalList, "parameters", {get: function() {
          return [[], [], [List]];
        }});
    }
  };
});

System.register("angular2/src/reflection/reflector", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/types"], function($__export) {
  "";
  var __moduleName = "angular2/src/reflection/reflector";
  var Type,
      isPresent,
      stringify,
      BaseException,
      List,
      ListWrapper,
      Map,
      MapWrapper,
      StringMapWrapper,
      SetterFn,
      GetterFn,
      MethodFn,
      Reflector;
  function _mergeMaps(target, config) {
    StringMapWrapper.forEach(config, (function(v, k) {
      return MapWrapper.set(target, k, v);
    }));
  }
  return {
    setters: [function($__m) {
      Type = $__m.Type;
      isPresent = $__m.isPresent;
      stringify = $__m.stringify;
      BaseException = $__m.BaseException;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      SetterFn = $__m.SetterFn;
      GetterFn = $__m.GetterFn;
      MethodFn = $__m.MethodFn;
      $__export("SetterFn", $__m.SetterFn);
      $__export("GetterFn", $__m.GetterFn);
      $__export("MethodFn", $__m.MethodFn);
    }],
    execute: function() {
      Reflector = $__export("Reflector", (function() {
        var Reflector = function Reflector(reflectionCapabilities) {
          this._typeInfo = MapWrapper.create();
          this._getters = MapWrapper.create();
          this._setters = MapWrapper.create();
          this._methods = MapWrapper.create();
          this.reflectionCapabilities = reflectionCapabilities;
        };
        return ($traceurRuntime.createClass)(Reflector, {
          registerType: function(type, typeInfo) {
            MapWrapper.set(this._typeInfo, type, typeInfo);
          },
          registerGetters: function(getters) {
            _mergeMaps(this._getters, getters);
          },
          registerSetters: function(setters) {
            _mergeMaps(this._setters, setters);
          },
          registerMethods: function(methods) {
            _mergeMaps(this._methods, methods);
          },
          factory: function(type) {
            if (MapWrapper.contains(this._typeInfo, type)) {
              return MapWrapper.get(this._typeInfo, type)["factory"];
            } else {
              return this.reflectionCapabilities.factory(type);
            }
          },
          parameters: function(typeOfFunc) {
            if (MapWrapper.contains(this._typeInfo, typeOfFunc)) {
              return MapWrapper.get(this._typeInfo, typeOfFunc)["parameters"];
            } else {
              return this.reflectionCapabilities.parameters(typeOfFunc);
            }
          },
          annotations: function(typeOfFunc) {
            if (MapWrapper.contains(this._typeInfo, typeOfFunc)) {
              return MapWrapper.get(this._typeInfo, typeOfFunc)["annotations"];
            } else {
              return this.reflectionCapabilities.annotations(typeOfFunc);
            }
          },
          getter: function(name) {
            if (MapWrapper.contains(this._getters, name)) {
              return MapWrapper.get(this._getters, name);
            } else {
              return this.reflectionCapabilities.getter(name);
            }
          },
          setter: function(name) {
            if (MapWrapper.contains(this._setters, name)) {
              return MapWrapper.get(this._setters, name);
            } else {
              return this.reflectionCapabilities.setter(name);
            }
          },
          method: function(name) {
            if (MapWrapper.contains(this._methods, name)) {
              return MapWrapper.get(this._methods, name);
            } else {
              return this.reflectionCapabilities.method(name);
            }
          }
        }, {});
      }()));
      Object.defineProperty(Reflector.prototype.factory, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(Reflector.prototype.getter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(Reflector.prototype.setter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(Reflector.prototype.method, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_mergeMaps, "parameters", {get: function() {
          return [[Map], []];
        }});
    }
  };
});

System.register("angular2/src/di/key", ["angular2/src/di/exceptions", "angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/di/key";
  var KeyMetadataError,
      MapWrapper,
      Map,
      int,
      isPresent,
      Key,
      KeyRegistry,
      _globalKeyRegistry;
  return {
    setters: [function($__m) {
      KeyMetadataError = $__m.KeyMetadataError;
    }, function($__m) {
      MapWrapper = $__m.MapWrapper;
      Map = $__m.Map;
    }, function($__m) {
      int = $__m.int;
      isPresent = $__m.isPresent;
    }],
    execute: function() {
      Key = $__export("Key", (function() {
        var Key = function Key(token, id) {
          this.token = token;
          this.id = id;
          this.metadata = null;
        };
        return ($traceurRuntime.createClass)(Key, {}, {
          setMetadata: function(key, metadata) {
            if (isPresent(key.metadata) && key.metadata !== metadata) {
              throw new KeyMetadataError();
            }
            key.metadata = metadata;
            return key;
          },
          get: function(token) {
            return _globalKeyRegistry.get(token);
          },
          get numberOfKeys() {
            return _globalKeyRegistry.numberOfKeys;
          }
        });
      }()));
      Object.defineProperty(Key, "parameters", {get: function() {
          return [[], [int]];
        }});
      Object.defineProperty(Key.setMetadata, "parameters", {get: function() {
          return [[Key], []];
        }});
      KeyRegistry = $__export("KeyRegistry", (function() {
        var KeyRegistry = function KeyRegistry() {
          this._allKeys = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(KeyRegistry, {
          get: function(token) {
            if (token instanceof Key)
              return token;
            if (MapWrapper.contains(this._allKeys, token)) {
              return MapWrapper.get(this._allKeys, token);
            }
            var newKey = new Key(token, Key.numberOfKeys);
            MapWrapper.set(this._allKeys, token, newKey);
            return newKey;
          },
          get numberOfKeys() {
            return MapWrapper.size(this._allKeys);
          }
        }, {});
      }()));
      _globalKeyRegistry = new KeyRegistry();
    }
  };
});

System.register("angular2/src/facade/async", ["angular2/src/facade/lang", "angular2/src/facade/collection", "rx/dist/rx.all"], function($__export) {
  "";
  var __moduleName = "angular2/src/facade/async";
  var int,
      global,
      isPresent,
      List,
      Rx,
      Promise,
      PromiseWrapper,
      Observable,
      ObservableController,
      ObservableWrapper;
  return {
    setters: [function($__m) {
      int = $__m.int;
      global = $__m.global;
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
    }, function($__m) {
      Rx = $__m.default;
    }],
    execute: function() {
      Promise = $__export("Promise", global.Promise);
      PromiseWrapper = $__export("PromiseWrapper", (function() {
        var PromiseWrapper = function PromiseWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(PromiseWrapper, {}, {
          resolve: function(obj) {
            return Promise.resolve(obj);
          },
          reject: function(obj) {
            return Promise.reject(obj);
          },
          catchError: function(promise, onError) {
            return promise.catch(onError);
          },
          all: function(promises) {
            if (promises.length == 0)
              return Promise.resolve([]);
            return Promise.all(promises);
          },
          then: function(promise, success, rejection) {
            return promise.then(success, rejection);
          },
          completer: function() {
            var resolve;
            var reject;
            var p = new Promise(function(res, rej) {
              resolve = res;
              reject = rej;
            });
            return {
              promise: p,
              resolve: resolve,
              reject: reject
            };
          },
          setTimeout: function(fn, millis) {
            global.setTimeout(fn, millis);
          },
          isPromise: function(maybePromise) {
            return maybePromise instanceof Promise;
          }
        });
      }()));
      Object.defineProperty(PromiseWrapper.catchError, "parameters", {get: function() {
          return [[Promise], [Function]];
        }});
      Object.defineProperty(PromiseWrapper.all, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(PromiseWrapper.then, "parameters", {get: function() {
          return [[Promise], [Function], [Function]];
        }});
      Object.defineProperty(PromiseWrapper.setTimeout, "parameters", {get: function() {
          return [[Function], [int]];
        }});
      Observable = $__export("Observable", Rx.Observable);
      ObservableController = $__export("ObservableController", Rx.Subject);
      ObservableWrapper = $__export("ObservableWrapper", (function() {
        var ObservableWrapper = function ObservableWrapper() {
          ;
        };
        return ($traceurRuntime.createClass)(ObservableWrapper, {}, {
          createController: function() {
            return new Rx.Subject();
          },
          createObservable: function(subject) {
            return subject;
          },
          subscribe: function(observable, generatorOrOnNext) {
            var onThrow = arguments[2] !== (void 0) ? arguments[2] : null;
            var onReturn = arguments[3] !== (void 0) ? arguments[3] : null;
            if (isPresent(generatorOrOnNext.next)) {
              return observable.observeOn(Rx.Scheduler.timeout).subscribe((function(value) {
                return generatorOrOnNext.next(value);
              }), (function(error) {
                return generatorOrOnNext.throw(error);
              }), (function() {
                return generatorOrOnNext.return();
              }));
            } else {
              return observable.observeOn(Rx.Scheduler.timeout).subscribe(generatorOrOnNext, onThrow, onReturn);
            }
          },
          callNext: function(subject, value) {
            subject.onNext(value);
          },
          callThrow: function(subject, error) {
            subject.onError(error);
          },
          callReturn: function(subject) {
            subject.onCompleted();
          }
        });
      }()));
      Object.defineProperty(ObservableWrapper.createObservable, "parameters", {get: function() {
          return [[Rx.Subject]];
        }});
      Object.defineProperty(ObservableWrapper.subscribe, "parameters", {get: function() {
          return [[Observable], [], [], []];
        }});
      Object.defineProperty(ObservableWrapper.callNext, "parameters", {get: function() {
          return [[Rx.Subject], [assert.type.any]];
        }});
      Object.defineProperty(ObservableWrapper.callThrow, "parameters", {get: function() {
          return [[Rx.Subject], [assert.type.any]];
        }});
      Object.defineProperty(ObservableWrapper.callReturn, "parameters", {get: function() {
          return [[Rx.Subject]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/exceptions", ["angular2/src/change_detection/proto_record"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/exceptions";
  var ProtoRecord,
      ExpressionChangedAfterItHasBeenChecked,
      ChangeDetectionError;
  return {
    setters: [function($__m) {
      ProtoRecord = $__m.ProtoRecord;
    }],
    execute: function() {
      ExpressionChangedAfterItHasBeenChecked = $__export("ExpressionChangedAfterItHasBeenChecked", (function($__super) {
        var ExpressionChangedAfterItHasBeenChecked = function ExpressionChangedAfterItHasBeenChecked(proto, change) {
          $traceurRuntime.superConstructor(ExpressionChangedAfterItHasBeenChecked).call(this);
          this.message = ("Expression '" + proto.expressionAsString + "' has changed after it was checked. ") + ("Previous value: '" + change.previousValue + "'. Current value: '" + change.currentValue + "'");
        };
        return ($traceurRuntime.createClass)(ExpressionChangedAfterItHasBeenChecked, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
      Object.defineProperty(ExpressionChangedAfterItHasBeenChecked, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.any]];
        }});
      ChangeDetectionError = $__export("ChangeDetectionError", (function($__super) {
        var ChangeDetectionError = function ChangeDetectionError(proto, originalException) {
          $traceurRuntime.superConstructor(ChangeDetectionError).call(this);
          this.originalException = originalException;
          this.location = proto.expressionAsString;
          this.message = (this.originalException + " in [" + this.location + "]");
        };
        return ($traceurRuntime.createClass)(ChangeDetectionError, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
      Object.defineProperty(ChangeDetectionError, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.any]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/change_detection_util", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/proto_record", "angular2/src/change_detection/exceptions", "angular2/src/change_detection/pipes/pipe", "angular2/src/change_detection/interfaces", "angular2/src/change_detection/constants"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/change_detection_util";
  var isPresent,
      isBlank,
      BaseException,
      Type,
      List,
      ListWrapper,
      MapWrapper,
      StringMapWrapper,
      ProtoRecord,
      ExpressionChangedAfterItHasBeenChecked,
      NO_CHANGE,
      ChangeRecord,
      ChangeDetector,
      CHECK_ALWAYS,
      CHECK_ONCE,
      CHECKED,
      DETACHED,
      ON_PUSH,
      uninitialized,
      SimpleChange,
      _simpleChangesIndex,
      _simpleChanges,
      _changeRecordsIndex,
      _changeRecords,
      _singleElementList,
      ChangeDetectionUtil;
  function _simpleChange(previousValue, currentValue) {
    var index = _simpleChangesIndex++ % 20;
    var s = _simpleChanges[index];
    s.previousValue = previousValue;
    s.currentValue = currentValue;
    return s;
  }
  function _changeRecord(bindingMemento, change) {
    var index = _changeRecordsIndex++ % 20;
    var s = _changeRecords[index];
    s.bindingMemento = bindingMemento;
    s.change = change;
    return s;
  }
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      Type = $__m.Type;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      ProtoRecord = $__m.ProtoRecord;
    }, function($__m) {
      ExpressionChangedAfterItHasBeenChecked = $__m.ExpressionChangedAfterItHasBeenChecked;
    }, function($__m) {
      NO_CHANGE = $__m.NO_CHANGE;
    }, function($__m) {
      ChangeRecord = $__m.ChangeRecord;
      ChangeDetector = $__m.ChangeDetector;
    }, function($__m) {
      CHECK_ALWAYS = $__m.CHECK_ALWAYS;
      CHECK_ONCE = $__m.CHECK_ONCE;
      CHECKED = $__m.CHECKED;
      DETACHED = $__m.DETACHED;
      ON_PUSH = $__m.ON_PUSH;
    }],
    execute: function() {
      uninitialized = $__export("uninitialized", new Object());
      SimpleChange = $__export("SimpleChange", (function() {
        var SimpleChange = function SimpleChange(previousValue, currentValue) {
          this.previousValue = previousValue;
          this.currentValue = currentValue;
        };
        return ($traceurRuntime.createClass)(SimpleChange, {}, {});
      }()));
      Object.defineProperty(SimpleChange, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any]];
        }});
      _simpleChangesIndex = 0;
      _simpleChanges = [new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null), new SimpleChange(null, null)];
      _changeRecordsIndex = 0;
      _changeRecords = [new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null), new ChangeRecord(null, null)];
      _singleElementList = [null];
      ChangeDetectionUtil = $__export("ChangeDetectionUtil", (function() {
        var ChangeDetectionUtil = function ChangeDetectionUtil() {
          ;
        };
        return ($traceurRuntime.createClass)(ChangeDetectionUtil, {}, {
          unitialized: function() {
            return uninitialized;
          },
          arrayFn0: function() {
            return [];
          },
          arrayFn1: function(a1) {
            return [a1];
          },
          arrayFn2: function(a1, a2) {
            return [a1, a2];
          },
          arrayFn3: function(a1, a2, a3) {
            return [a1, a2, a3];
          },
          arrayFn4: function(a1, a2, a3, a4) {
            return [a1, a2, a3, a4];
          },
          arrayFn5: function(a1, a2, a3, a4, a5) {
            return [a1, a2, a3, a4, a5];
          },
          arrayFn6: function(a1, a2, a3, a4, a5, a6) {
            return [a1, a2, a3, a4, a5, a6];
          },
          arrayFn7: function(a1, a2, a3, a4, a5, a6, a7) {
            return [a1, a2, a3, a4, a5, a6, a7];
          },
          arrayFn8: function(a1, a2, a3, a4, a5, a6, a7, a8) {
            return [a1, a2, a3, a4, a5, a6, a7, a8];
          },
          arrayFn9: function(a1, a2, a3, a4, a5, a6, a7, a8, a9) {
            return [a1, a2, a3, a4, a5, a6, a7, a8, a9];
          },
          operation_negate: function(value) {
            return !value;
          },
          operation_add: function(left, right) {
            return left + right;
          },
          operation_subtract: function(left, right) {
            return left - right;
          },
          operation_multiply: function(left, right) {
            return left * right;
          },
          operation_divide: function(left, right) {
            return left / right;
          },
          operation_remainder: function(left, right) {
            return left % right;
          },
          operation_equals: function(left, right) {
            return left == right;
          },
          operation_not_equals: function(left, right) {
            return left != right;
          },
          operation_less_then: function(left, right) {
            return left < right;
          },
          operation_greater_then: function(left, right) {
            return left > right;
          },
          operation_less_or_equals_then: function(left, right) {
            return left <= right;
          },
          operation_greater_or_equals_then: function(left, right) {
            return left >= right;
          },
          operation_logical_and: function(left, right) {
            return left && right;
          },
          operation_logical_or: function(left, right) {
            return left || right;
          },
          cond: function(cond, trueVal, falseVal) {
            return cond ? trueVal : falseVal;
          },
          mapFn: function(keys) {
            function buildMap(values) {
              var res = StringMapWrapper.create();
              for (var i = 0; i < keys.length; ++i) {
                StringMapWrapper.set(res, keys[i], values[i]);
              }
              return res;
            }
            switch (keys.length) {
              case 0:
                return (function() {
                  return [];
                });
              case 1:
                return (function(a1) {
                  return buildMap([a1]);
                });
              case 2:
                return (function(a1, a2) {
                  return buildMap([a1, a2]);
                });
              case 3:
                return (function(a1, a2, a3) {
                  return buildMap([a1, a2, a3]);
                });
              case 4:
                return (function(a1, a2, a3, a4) {
                  return buildMap([a1, a2, a3, a4]);
                });
              case 5:
                return (function(a1, a2, a3, a4, a5) {
                  return buildMap([a1, a2, a3, a4, a5]);
                });
              case 6:
                return (function(a1, a2, a3, a4, a5, a6) {
                  return buildMap([a1, a2, a3, a4, a5, a6]);
                });
              case 7:
                return (function(a1, a2, a3, a4, a5, a6, a7) {
                  return buildMap([a1, a2, a3, a4, a5, a6, a7]);
                });
              case 8:
                return (function(a1, a2, a3, a4, a5, a6, a7, a8) {
                  return buildMap([a1, a2, a3, a4, a5, a6, a7, a8]);
                });
              case 9:
                return (function(a1, a2, a3, a4, a5, a6, a7, a8, a9) {
                  return buildMap([a1, a2, a3, a4, a5, a6, a7, a8, a9]);
                });
              default:
                throw new BaseException("Does not support literal maps with more than 9 elements");
            }
          },
          keyedAccess: function(obj, args) {
            return obj[args[0]];
          },
          noChangeMarker: function(value) {
            return value === NO_CHANGE;
          },
          throwOnChange: function(proto, change) {
            throw new ExpressionChangedAfterItHasBeenChecked(proto, change);
          },
          simpleChange: function(previousValue, currentValue) {
            return _simpleChange(previousValue, currentValue);
          },
          changeRecord: function(memento, change) {
            return _changeRecord(memento, change);
          },
          simpleChangeRecord: function(memento, previousValue, currentValue) {
            return _changeRecord(memento, _simpleChange(previousValue, currentValue));
          },
          changeDetectionMode: function(strategy) {
            return strategy == ON_PUSH ? CHECK_ONCE : CHECK_ALWAYS;
          },
          addRecord: function(updatedRecords, changeRecord) {
            if (isBlank(updatedRecords)) {
              updatedRecords = _singleElementList;
              updatedRecords[0] = changeRecord;
            } else if (updatedRecords === _singleElementList) {
              updatedRecords = [_singleElementList[0], changeRecord];
            } else {
              ListWrapper.push(updatedRecords, changeRecord);
            }
            return updatedRecords;
          }
        });
      }()));
      Object.defineProperty(ChangeDetectionUtil.mapFn, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(ChangeDetectionUtil.throwOnChange, "parameters", {get: function() {
          return [[ProtoRecord], []];
        }});
      Object.defineProperty(ChangeDetectionUtil.simpleChange, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any]];
        }});
      Object.defineProperty(ChangeDetectionUtil.changeRecord, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any]];
        }});
      Object.defineProperty(ChangeDetectionUtil.simpleChangeRecord, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any], [assert.type.any]];
        }});
      Object.defineProperty(ChangeDetectionUtil.changeDetectionMode, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ChangeDetectionUtil.addRecord, "parameters", {get: function() {
          return [[List], [ChangeRecord]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/abstract_change_detector", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/binding_propagation_config", "angular2/src/change_detection/interfaces", "angular2/src/change_detection/constants"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/abstract_change_detector";
  var isPresent,
      List,
      ListWrapper,
      BindingPropagationConfig,
      ChangeDetector,
      CHECK_ALWAYS,
      CHECK_ONCE,
      CHECKED,
      DETACHED,
      ON_PUSH,
      AbstractChangeDetector;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      BindingPropagationConfig = $__m.BindingPropagationConfig;
    }, function($__m) {
      ChangeDetector = $__m.ChangeDetector;
    }, function($__m) {
      CHECK_ALWAYS = $__m.CHECK_ALWAYS;
      CHECK_ONCE = $__m.CHECK_ONCE;
      CHECKED = $__m.CHECKED;
      DETACHED = $__m.DETACHED;
      ON_PUSH = $__m.ON_PUSH;
    }],
    execute: function() {
      AbstractChangeDetector = $__export("AbstractChangeDetector", (function($__super) {
        var AbstractChangeDetector = function AbstractChangeDetector() {
          $traceurRuntime.superConstructor(AbstractChangeDetector).call(this);
          this.lightDomChildren = [];
          this.shadowDomChildren = [];
          this.bindingPropagationConfig = new BindingPropagationConfig(this);
          this.mode = null;
        };
        return ($traceurRuntime.createClass)(AbstractChangeDetector, {
          addChild: function(cd) {
            ListWrapper.push(this.lightDomChildren, cd);
            cd.parent = this;
          },
          removeChild: function(cd) {
            ListWrapper.remove(this.lightDomChildren, cd);
          },
          addShadowDomChild: function(cd) {
            ListWrapper.push(this.shadowDomChildren, cd);
            cd.parent = this;
          },
          remove: function() {
            this.parent.removeChild(this);
          },
          detectChanges: function() {
            this._detectChanges(false);
          },
          checkNoChanges: function() {
            this._detectChanges(true);
          },
          _detectChanges: function(throwOnChange) {
            if (this.mode === DETACHED || this.mode === CHECKED)
              return ;
            this.detectChangesInRecords(throwOnChange);
            this._detectChangesInLightDomChildren(throwOnChange);
            this.callOnAllChangesDone();
            this._detectChangesInShadowDomChildren(throwOnChange);
            if (this.mode === CHECK_ONCE)
              this.mode = CHECKED;
          },
          detectChangesInRecords: function(throwOnChange) {},
          callOnAllChangesDone: function() {},
          _detectChangesInLightDomChildren: function(throwOnChange) {
            var c = this.lightDomChildren;
            for (var i = 0; i < c.length; ++i) {
              c[i]._detectChanges(throwOnChange);
            }
          },
          _detectChangesInShadowDomChildren: function(throwOnChange) {
            var c = this.shadowDomChildren;
            for (var i = 0; i < c.length; ++i) {
              c[i]._detectChanges(throwOnChange);
            }
          },
          markPathToRootAsCheckOnce: function() {
            var c = this;
            while (isPresent(c) && c.mode != DETACHED) {
              if (c.mode === CHECKED)
                c.mode = CHECK_ONCE;
              c = c.parent;
            }
          }
        }, {}, $__super);
      }(ChangeDetector)));
      Object.defineProperty(AbstractChangeDetector.prototype.addChild, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype.removeChild, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype.addShadowDomChild, "parameters", {get: function() {
          return [[ChangeDetector]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype._detectChanges, "parameters", {get: function() {
          return [[assert.type.boolean]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype.detectChangesInRecords, "parameters", {get: function() {
          return [[assert.type.boolean]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype._detectChangesInLightDomChildren, "parameters", {get: function() {
          return [[assert.type.boolean]];
        }});
      Object.defineProperty(AbstractChangeDetector.prototype._detectChangesInShadowDomChildren, "parameters", {get: function() {
          return [[assert.type.boolean]];
        }});
    }
  };
});

System.register("angular2/src/dom/browser_adapter", ["angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/dom/dom_adapter", "angular2/src/dom/generic_browser_adapter"], function($__export) {
  "";
  var __moduleName = "angular2/src/dom/browser_adapter";
  var List,
      MapWrapper,
      ListWrapper,
      isPresent,
      setRootDomAdapter,
      GenericBrowserDomAdapter,
      _attrToPropMap,
      BrowserDomAdapter;
  return {
    setters: [function($__m) {
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      setRootDomAdapter = $__m.setRootDomAdapter;
    }, function($__m) {
      GenericBrowserDomAdapter = $__m.GenericBrowserDomAdapter;
    }],
    execute: function() {
      _attrToPropMap = {
        'innerHtml': 'innerHTML',
        'readonly': 'readOnly',
        'tabindex': 'tabIndex'
      };
      BrowserDomAdapter = $__export("BrowserDomAdapter", (function($__super) {
        var BrowserDomAdapter = function BrowserDomAdapter() {
          $traceurRuntime.superConstructor(BrowserDomAdapter).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(BrowserDomAdapter, {
          get attrToPropMap() {
            return _attrToPropMap;
          },
          query: function(selector) {
            return document.querySelector(selector);
          },
          querySelector: function(el, selector) {
            return el.querySelector(selector);
          },
          querySelectorAll: function(el, selector) {
            return el.querySelectorAll(selector);
          },
          on: function(el, evt, listener) {
            el.addEventListener(evt, listener, false);
          },
          dispatchEvent: function(el, evt) {
            el.dispatchEvent(evt);
          },
          createMouseEvent: function(eventType) {
            var evt = new MouseEvent(eventType);
            evt.initEvent(eventType, true, true);
            return evt;
          },
          createEvent: function(eventType) {
            return new Event(eventType, true);
          },
          getInnerHTML: function(el) {
            return el.innerHTML;
          },
          getOuterHTML: function(el) {
            return el.outerHTML;
          },
          nodeName: function(node) {
            return node.nodeName;
          },
          nodeValue: function(node) {
            return node.nodeValue;
          },
          type: function(node) {
            return node.type;
          },
          content: function(node) {
            if (this.hasProperty(node, "content")) {
              return node.content;
            } else {
              return node;
            }
          },
          firstChild: function(el) {
            return el.firstChild;
          },
          nextSibling: function(el) {
            return el.nextSibling;
          },
          parentElement: function(el) {
            return el.parentElement;
          },
          childNodes: function(el) {
            return el.childNodes;
          },
          childNodesAsList: function(el) {
            var childNodes = el.childNodes;
            var res = ListWrapper.createFixedSize(childNodes.length);
            for (var i = 0; i < childNodes.length; i++) {
              res[i] = childNodes[i];
            }
            return res;
          },
          clearNodes: function(el) {
            for (var i = 0; i < el.childNodes.length; i++) {
              this.remove(el.childNodes[i]);
            }
          },
          appendChild: function(el, node) {
            el.appendChild(node);
          },
          removeChild: function(el, node) {
            el.removeChild(node);
          },
          replaceChild: function(el, newChild, oldChild) {
            el.replaceChild(newChild, oldChild);
          },
          remove: function(el) {
            var parent = el.parentNode;
            parent.removeChild(el);
            return el;
          },
          insertBefore: function(el, node) {
            el.parentNode.insertBefore(node, el);
          },
          insertAllBefore: function(el, nodes) {
            ListWrapper.forEach(nodes, (function(n) {
              el.parentNode.insertBefore(n, el);
            }));
          },
          insertAfter: function(el, node) {
            el.parentNode.insertBefore(node, el.nextSibling);
          },
          setInnerHTML: function(el, value) {
            el.innerHTML = value;
          },
          getText: function(el) {
            return el.textContent;
          },
          setText: function(el, value) {
            el.textContent = value;
          },
          getValue: function(el) {
            return el.value;
          },
          setValue: function(el, value) {
            el.value = value;
          },
          getChecked: function(el) {
            return el.checked;
          },
          setChecked: function(el, value) {
            el.checked = value;
          },
          createTemplate: function(html) {
            var t = document.createElement('template');
            t.innerHTML = html;
            return t;
          },
          createElement: function(tagName) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : document;
            return doc.createElement(tagName);
          },
          createTextNode: function(text) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : document;
            return doc.createTextNode(text);
          },
          createScriptTag: function(attrName, attrValue) {
            var doc = arguments[2] !== (void 0) ? arguments[2] : document;
            var el = doc.createElement('SCRIPT');
            el.setAttribute(attrName, attrValue);
            return el;
          },
          createStyleElement: function(css) {
            var doc = arguments[1] !== (void 0) ? arguments[1] : document;
            var style = doc.createElement('STYLE');
            style.innerText = css;
            return style;
          },
          createShadowRoot: function(el) {
            return el.createShadowRoot();
          },
          getShadowRoot: function(el) {
            return el.shadowRoot;
          },
          getHost: function(el) {
            return el.host;
          },
          clone: function(node) {
            return node.cloneNode(true);
          },
          hasProperty: function(element, name) {
            return name in element;
          },
          getElementsByClassName: function(element, name) {
            return element.getElementsByClassName(name);
          },
          getElementsByTagName: function(element, name) {
            return element.getElementsByTagName(name);
          },
          classList: function(element) {
            return Array.prototype.slice.call(element.classList, 0);
          },
          addClass: function(element, classname) {
            element.classList.add(classname);
          },
          removeClass: function(element, classname) {
            element.classList.remove(classname);
          },
          hasClass: function(element, classname) {
            return element.classList.contains(classname);
          },
          setStyle: function(element, stylename, stylevalue) {
            element.style[stylename] = stylevalue;
          },
          removeStyle: function(element, stylename) {
            element.style[stylename] = null;
          },
          getStyle: function(element, stylename) {
            return element.style[stylename];
          },
          tagName: function(element) {
            return element.tagName;
          },
          attributeMap: function(element) {
            var res = MapWrapper.create();
            var elAttrs = element.attributes;
            for (var i = 0; i < elAttrs.length; i++) {
              var attrib = elAttrs[i];
              MapWrapper.set(res, attrib.name, attrib.value);
            }
            return res;
          },
          getAttribute: function(element, attribute) {
            return element.getAttribute(attribute);
          },
          setAttribute: function(element, name, value) {
            element.setAttribute(name, value);
          },
          removeAttribute: function(element, attribute) {
            return element.removeAttribute(attribute);
          },
          templateAwareRoot: function(el) {
            return this.isTemplateElement(el) ? this.content(el) : el;
          },
          createHtmlDocument: function() {
            return document.implementation.createHTMLDocument('fakeTitle');
          },
          defaultDoc: function() {
            return document;
          },
          getTitle: function() {
            return document.title;
          },
          setTitle: function(newTitle) {
            document.title = newTitle;
          },
          elementMatches: function(n, selector) {
            return n instanceof HTMLElement && n.matches(selector);
          },
          isTemplateElement: function(el) {
            return el instanceof HTMLElement && el.nodeName == "TEMPLATE";
          },
          isTextNode: function(node) {
            return node.nodeType === Node.TEXT_NODE;
          },
          isCommentNode: function(node) {
            return node.nodeType === Node.COMMENT_NODE;
          },
          isElementNode: function(node) {
            return node.nodeType === Node.ELEMENT_NODE;
          },
          hasShadowRoot: function(node) {
            return node instanceof HTMLElement && isPresent(node.shadowRoot);
          },
          isShadowRoot: function(node) {
            return node instanceof ShadowRoot;
          },
          importIntoDoc: function(node) {
            var result = document.importNode(node, true);
            if (this.isTemplateElement(result) && !this.content(result).childNodes.length && this.content(node).childNodes.length) {
              var childNodes = this.content(node).childNodes;
              for (var i = 0; i < childNodes.length; ++i) {
                this.content(result).appendChild(this.importIntoDoc(childNodes[i]));
              }
            }
            return result;
          },
          isPageRule: function(rule) {
            return rule.type === CSSRule.PAGE_RULE;
          },
          isStyleRule: function(rule) {
            return rule.type === CSSRule.STYLE_RULE;
          },
          isMediaRule: function(rule) {
            return rule.type === CSSRule.MEDIA_RULE;
          },
          isKeyframesRule: function(rule) {
            return rule.type === CSSRule.KEYFRAMES_RULE;
          },
          getHref: function(el) {
            return el.href;
          }
        }, {makeCurrent: function() {
            setRootDomAdapter(new BrowserDomAdapter());
          }}, $__super);
      }(GenericBrowserDomAdapter)));
      Object.defineProperty(BrowserDomAdapter.prototype.query, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.querySelector, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.querySelectorAll, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.nodeName, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.nodeValue, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.type, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.content, "parameters", {get: function() {
          return [[HTMLElement]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.replaceChild, "parameters", {get: function() {
          return [[Node], [], []];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setText, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setValue, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setChecked, "parameters", {get: function() {
          return [[], [assert.type.boolean]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.createTextNode, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.createScriptTag, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], []];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.createStyleElement, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.createShadowRoot, "parameters", {get: function() {
          return [[HTMLElement]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getShadowRoot, "parameters", {get: function() {
          return [[HTMLElement]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getHost, "parameters", {get: function() {
          return [[HTMLElement]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.clone, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.hasProperty, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getElementsByClassName, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getElementsByTagName, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.addClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.removeClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.hasClass, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setStyle, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.removeStyle, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getStyle, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getAttribute, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setAttribute, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.removeAttribute, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.setTitle, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.elementMatches, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.isTemplateElement, "parameters", {get: function() {
          return [[assert.type.any]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.isTextNode, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.isCommentNode, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.isElementNode, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.importIntoDoc, "parameters", {get: function() {
          return [[Node]];
        }});
      Object.defineProperty(BrowserDomAdapter.prototype.getHref, "parameters", {get: function() {
          return [[Element]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/directive_metadata_reader", ["angular2/di", "angular2/src/facade/lang", "angular2/src/core/annotations/annotations", "angular2/src/core/compiler/directive_metadata", "angular2/src/reflection/reflection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/directive_metadata_reader";
  var Injectable,
      Type,
      isPresent,
      BaseException,
      stringify,
      Directive,
      DirectiveMetadata,
      reflector,
      DirectiveMetadataReader;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Type = $__m.Type;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      stringify = $__m.stringify;
    }, function($__m) {
      Directive = $__m.Directive;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      reflector = $__m.reflector;
    }],
    execute: function() {
      DirectiveMetadataReader = $__export("DirectiveMetadataReader", (function() {
        var DirectiveMetadataReader = function DirectiveMetadataReader() {
          ;
        };
        return ($traceurRuntime.createClass)(DirectiveMetadataReader, {read: function(type) {
            var annotations = reflector.annotations(type);
            if (isPresent(annotations)) {
              for (var i = 0; i < annotations.length; i++) {
                var annotation = annotations[i];
                if (annotation instanceof Directive) {
                  return new DirectiveMetadata(type, annotation);
                }
              }
            }
            throw new BaseException(("No Directive annotation found on " + stringify(type)));
          }}, {});
      }()));
      Object.defineProperty(DirectiveMetadataReader, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(DirectiveMetadataReader.prototype.read, "parameters", {get: function() {
          return [[Type]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/events/event_manager", ["angular2/src/facade/lang", "angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/src/core/zone/vm_turn_zone"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/events/event_manager";
  var isBlank,
      BaseException,
      isPresent,
      StringWrapper,
      DOM,
      List,
      ListWrapper,
      MapWrapper,
      VmTurnZone,
      BUBBLE_SYMBOL,
      EventManager,
      EventManagerPlugin,
      DomEventsPlugin;
  return {
    setters: [function($__m) {
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      isPresent = $__m.isPresent;
      StringWrapper = $__m.StringWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      VmTurnZone = $__m.VmTurnZone;
    }],
    execute: function() {
      BUBBLE_SYMBOL = '^';
      EventManager = $__export("EventManager", (function() {
        var EventManager = function EventManager(plugins, zone) {
          this._zone = zone;
          this._plugins = plugins;
          for (var i = 0; i < plugins.length; i++) {
            plugins[i].manager = this;
          }
        };
        return ($traceurRuntime.createClass)(EventManager, {
          addEventListener: function(element, eventName, handler) {
            var shouldSupportBubble = eventName[0] == BUBBLE_SYMBOL;
            if (shouldSupportBubble) {
              eventName = StringWrapper.substring(eventName, 1);
            }
            var plugin = this._findPluginFor(eventName);
            plugin.addEventListener(element, eventName, handler, shouldSupportBubble);
          },
          getZone: function() {
            return this._zone;
          },
          _findPluginFor: function(eventName) {
            var plugins = this._plugins;
            for (var i = 0; i < plugins.length; i++) {
              var plugin = plugins[i];
              if (plugin.supports(eventName)) {
                return plugin;
              }
            }
            throw new BaseException(("No event manager plugin found for event " + eventName));
          }
        }, {});
      }()));
      Object.defineProperty(EventManager, "parameters", {get: function() {
          return [[assert.genericType(List, EventManagerPlugin)], [VmTurnZone]];
        }});
      Object.defineProperty(EventManager.prototype.addEventListener, "parameters", {get: function() {
          return [[], [assert.type.string], [Function]];
        }});
      Object.defineProperty(EventManager.prototype._findPluginFor, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      EventManagerPlugin = $__export("EventManagerPlugin", (function() {
        var EventManagerPlugin = function EventManagerPlugin() {
          ;
        };
        return ($traceurRuntime.createClass)(EventManagerPlugin, {
          supports: function(eventName) {
            return false;
          },
          addEventListener: function(element, eventName, handler, shouldSupportBubble) {
            throw "not implemented";
          }
        }, {});
      }()));
      Object.defineProperty(EventManagerPlugin.prototype.supports, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(EventManagerPlugin.prototype.addEventListener, "parameters", {get: function() {
          return [[], [assert.type.string], [Function], [assert.type.boolean]];
        }});
      DomEventsPlugin = $__export("DomEventsPlugin", (function($__super) {
        var DomEventsPlugin = function DomEventsPlugin() {
          $traceurRuntime.superConstructor(DomEventsPlugin).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(DomEventsPlugin, {
          supports: function(eventName) {
            return true;
          },
          addEventListener: function(element, eventName, handler, shouldSupportBubble) {
            var outsideHandler = shouldSupportBubble ? DomEventsPlugin.bubbleCallback(element, handler, this.manager._zone) : DomEventsPlugin.sameElementCallback(element, handler, this.manager._zone);
            this.manager._zone.runOutsideAngular((function() {
              DOM.on(element, eventName, outsideHandler);
            }));
          }
        }, {
          sameElementCallback: function(element, handler, zone) {
            return (function(event) {
              if (event.target === element) {
                zone.run((function() {
                  return handler(event);
                }));
              }
            });
          },
          bubbleCallback: function(element, handler, zone) {
            return (function(event) {
              return zone.run((function() {
                return handler(event);
              }));
            });
          }
        }, $__super);
      }(EventManagerPlugin)));
      Object.defineProperty(DomEventsPlugin.prototype.supports, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(DomEventsPlugin.prototype.addEventListener, "parameters", {get: function() {
          return [[], [assert.type.string], [Function], [assert.type.boolean]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/shadow_dom_emulation/light_dom", ["angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/core/compiler/view", "angular2/src/core/compiler/shadow_dom_emulation/content_tag"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/shadow_dom_emulation/light_dom";
  var DOM,
      List,
      ListWrapper,
      isBlank,
      isPresent,
      viewModule,
      Content,
      DestinationLightDom,
      _Root,
      LightDom;
  function redistributeNodes(contents, nodes) {
    for (var i = 0; i < contents.length; ++i) {
      var content = contents[i];
      var select = content.select;
      var matchSelector = (function(n) {
        return DOM.elementMatches(n, select);
      });
      if (select.length === 0) {
        content.insert(nodes);
        ListWrapper.clear(nodes);
      } else {
        var matchingNodes = ListWrapper.filter(nodes, matchSelector);
        content.insert(matchingNodes);
        ListWrapper.removeAll(nodes, matchingNodes);
      }
    }
  }
  return {
    setters: [function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
    }, function($__m) {
      viewModule = $__m;
    }, function($__m) {
      Content = $__m.Content;
    }],
    execute: function() {
      DestinationLightDom = $__export("DestinationLightDom", (function() {
        var DestinationLightDom = function DestinationLightDom() {
          ;
        };
        return ($traceurRuntime.createClass)(DestinationLightDom, {}, {});
      }()));
      _Root = (function() {
        var _Root = function _Root(node, viewContainer, content) {
          this.node = node;
          this.viewContainer = viewContainer;
          this.content = content;
        };
        return ($traceurRuntime.createClass)(_Root, {}, {});
      }());
      LightDom = $__export("LightDom", (function() {
        var LightDom = function LightDom(lightDomView, shadowDomView, element) {
          this.lightDomView = lightDomView;
          this.shadowDomView = shadowDomView;
          this.nodes = DOM.childNodesAsList(element);
          this.roots = null;
        };
        return ($traceurRuntime.createClass)(LightDom, {
          redistribute: function() {
            var tags = this.contentTags();
            if (tags.length > 0) {
              redistributeNodes(tags, this.expandedDomNodes());
            }
          },
          contentTags: function() {
            return this._collectAllContentTags(this.shadowDomView, []);
          },
          _collectAllContentTags: function(view, acc) {
            var $__0 = this;
            var contentTags = view.contentTags;
            var vcs = view.viewContainers;
            for (var i = 0; i < vcs.length; i++) {
              var vc = vcs[i];
              var contentTag = contentTags[i];
              if (isPresent(contentTag)) {
                ListWrapper.push(acc, contentTag);
              }
              if (isPresent(vc)) {
                ListWrapper.forEach(vc.contentTagContainers(), (function(view) {
                  $__0._collectAllContentTags(view, acc);
                }));
              }
            }
            return acc;
          },
          expandedDomNodes: function() {
            var res = [];
            var roots = this._roots();
            for (var i = 0; i < roots.length; ++i) {
              var root = roots[i];
              if (isPresent(root.viewContainer)) {
                res = ListWrapper.concat(res, root.viewContainer.nodes());
              } else if (isPresent(root.content)) {
                res = ListWrapper.concat(res, root.content.nodes());
              } else {
                ListWrapper.push(res, root.node);
              }
            }
            return res;
          },
          _roots: function() {
            if (isPresent(this.roots))
              return this.roots;
            var viewContainers = this.lightDomView.viewContainers;
            var contentTags = this.lightDomView.contentTags;
            this.roots = ListWrapper.map(this.nodes, (function(n) {
              var foundVc = null;
              var foundContentTag = null;
              for (var i = 0; i < viewContainers.length; i++) {
                var vc = viewContainers[i];
                var contentTag = contentTags[i];
                if (isPresent(vc) && vc.templateElement === n) {
                  foundVc = vc;
                }
                if (isPresent(contentTag) && contentTag.contentStartElement === n) {
                  foundContentTag = contentTag;
                }
              }
              return new _Root(n, foundVc, foundContentTag);
            }));
            return this.roots;
          }
        }, {});
      }()));
      Object.defineProperty(LightDom, "parameters", {get: function() {
          return [[viewModule.View], [viewModule.View], []];
        }});
      Object.defineProperty(LightDom.prototype._collectAllContentTags, "parameters", {get: function() {
          return [[viewModule.View], [assert.genericType(List, Content)]];
        }});
      Object.defineProperty(redistributeNodes, "parameters", {get: function() {
          return [[assert.genericType(List, Content)], [List]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/shadow_dom/style_inliner", ["angular2/di", "angular2/src/services/xhr", "angular2/src/facade/collection", "angular2/src/services/url_resolver", "angular2/src/render/dom/shadow_dom/style_url_resolver", "angular2/src/facade/lang", "angular2/src/facade/async"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/shadow_dom/style_inliner";
  var Injectable,
      XHR,
      ListWrapper,
      UrlResolver,
      StyleUrlResolver,
      isBlank,
      isPresent,
      RegExp,
      RegExpWrapper,
      StringWrapper,
      normalizeBlank,
      Promise,
      PromiseWrapper,
      StyleInliner,
      _importRe,
      _urlRe,
      _mediaQueryRe;
  function _extractUrl(importRule) {
    var match = RegExpWrapper.firstMatch(_urlRe, importRule);
    if (isBlank(match))
      return null;
    return isPresent(match[1]) ? match[1] : match[2];
  }
  function _extractMediaQuery(importRule) {
    var match = RegExpWrapper.firstMatch(_mediaQueryRe, importRule);
    if (isBlank(match))
      return null;
    var mediaQuery = match[1].trim();
    return (mediaQuery.length > 0) ? mediaQuery : null;
  }
  function _wrapInMediaRule(css, query) {
    return (isBlank(query)) ? css : ("@media " + query + " {\n" + css + "\n}");
  }
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      XHR = $__m.XHR;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      UrlResolver = $__m.UrlResolver;
    }, function($__m) {
      StyleUrlResolver = $__m.StyleUrlResolver;
    }, function($__m) {
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      RegExp = $__m.RegExp;
      RegExpWrapper = $__m.RegExpWrapper;
      StringWrapper = $__m.StringWrapper;
      normalizeBlank = $__m.normalizeBlank;
    }, function($__m) {
      Promise = $__m.Promise;
      PromiseWrapper = $__m.PromiseWrapper;
    }],
    execute: function() {
      StyleInliner = $__export("StyleInliner", (function() {
        var StyleInliner = function StyleInliner(xhr, styleUrlResolver, urlResolver) {
          this._xhr = xhr;
          this._urlResolver = urlResolver;
          this._styleUrlResolver = styleUrlResolver;
        };
        return ($traceurRuntime.createClass)(StyleInliner, {
          inlineImports: function(cssText, baseUrl) {
            return this._inlineImports(cssText, baseUrl, []);
          },
          _inlineImports: function(cssText, baseUrl, inlinedUrls) {
            var $__0 = this;
            var partIndex = 0;
            var parts = StringWrapper.split(cssText, _importRe);
            if (parts.length === 1) {
              return cssText;
            }
            var promises = [];
            while (partIndex < parts.length - 1) {
              var prefix = parts[partIndex];
              var rule = parts[partIndex + 1];
              var url = _extractUrl(rule);
              if (isPresent(url)) {
                url = this._urlResolver.resolve(baseUrl, url);
              }
              var mediaQuery = _extractMediaQuery(rule);
              var promise = void 0;
              if (isBlank(url)) {
                promise = PromiseWrapper.resolve(("/* Invalid import rule: \"@import " + rule + ";\" */"));
              } else if (ListWrapper.contains(inlinedUrls, url)) {
                promise = PromiseWrapper.resolve(prefix);
              } else {
                ListWrapper.push(inlinedUrls, url);
                promise = PromiseWrapper.then(this._xhr.get(url), (function(css) {
                  css = $__0._inlineImports(css, url, inlinedUrls);
                  if (PromiseWrapper.isPromise(css)) {
                    return css.then((function(css) {
                      return prefix + $__0._transformImportedCss(css, mediaQuery, url) + '\n';
                    }));
                  } else {
                    return prefix + $__0._transformImportedCss(css, mediaQuery, url) + '\n';
                  }
                }), (function(error) {
                  return ("/* failed to import " + url + " */\n");
                }));
              }
              ListWrapper.push(promises, promise);
              partIndex += 2;
            }
            return PromiseWrapper.all(promises).then(function(cssParts) {
              var cssText = cssParts.join('');
              if (partIndex < parts.length) {
                cssText += parts[partIndex];
              }
              return cssText;
            });
          },
          _transformImportedCss: function(css, mediaQuery, url) {
            css = this._styleUrlResolver.resolveUrls(css, url);
            return _wrapInMediaRule(css, mediaQuery);
          }
        }, {});
      }()));
      Object.defineProperty(StyleInliner, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(StyleInliner, "parameters", {get: function() {
          return [[XHR], [StyleUrlResolver], [UrlResolver]];
        }});
      Object.defineProperty(StyleInliner.prototype.inlineImports, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(StyleInliner.prototype._inlineImports, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.genericType(List, assert.type.string)]];
        }});
      Object.defineProperty(StyleInliner.prototype._transformImportedCss, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(_extractUrl, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_extractMediaQuery, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_wrapInMediaRule, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      _importRe = RegExpWrapper.create('@import\\s+([^;]+);');
      _urlRe = RegExpWrapper.create('url\\(\\s*?[\'"]?([^\'")]+)[\'"]?|' + '[\'"]([^\'")]+)[\'"]');
      _mediaQueryRe = RegExpWrapper.create('[\'"][^\'"]+[\'"]\\s*\\)?\\s*(.*)');
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/compile_element", ["angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/facade/lang", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/annotations/annotations", "angular2/src/core/compiler/element_binder", "angular2/src/core/compiler/element_injector", "angular2/src/core/compiler/view", "angular2/src/core/compiler/string_utils", "angular2/change_detection"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/compile_element";
  var List,
      Map,
      ListWrapper,
      MapWrapper,
      DOM,
      int,
      isBlank,
      isPresent,
      Type,
      StringJoiner,
      assertionsEnabled,
      DirectiveMetadata,
      Decorator,
      Component,
      Viewport,
      DynamicComponent,
      ElementBinder,
      ProtoElementInjector,
      viewModule,
      dashCaseToCamelCase,
      AST,
      CompileElement;
  function getElementDescription(domElement) {
    var buf = new StringJoiner();
    var atts = DOM.attributeMap(domElement);
    buf.add("<");
    buf.add(DOM.tagName(domElement).toLowerCase());
    addDescriptionAttribute(buf, "id", MapWrapper.get(atts, "id"));
    addDescriptionAttribute(buf, "class", MapWrapper.get(atts, "class"));
    MapWrapper.forEach(atts, (function(attValue, attName) {
      if (attName !== "id" && attName !== "class") {
        addDescriptionAttribute(buf, attName, attValue);
      }
    }));
    buf.add(">");
    return buf.toString();
  }
  function addDescriptionAttribute(buffer, attName, attValue) {
    if (isPresent(attValue)) {
      if (attValue.length === 0) {
        buffer.add(' ' + attName);
      } else {
        buffer.add(' ' + attName + '="' + attValue + '"');
      }
    }
  }
  return {
    setters: [function($__m) {
      List = $__m.List;
      Map = $__m.Map;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      int = $__m.int;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      Type = $__m.Type;
      StringJoiner = $__m.StringJoiner;
      assertionsEnabled = $__m.assertionsEnabled;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      Decorator = $__m.Decorator;
      Component = $__m.Component;
      Viewport = $__m.Viewport;
      DynamicComponent = $__m.DynamicComponent;
    }, function($__m) {
      ElementBinder = $__m.ElementBinder;
    }, function($__m) {
      ProtoElementInjector = $__m.ProtoElementInjector;
    }, function($__m) {
      viewModule = $__m;
    }, function($__m) {
      dashCaseToCamelCase = $__m.dashCaseToCamelCase;
    }, function($__m) {
      AST = $__m.AST;
    }],
    execute: function() {
      CompileElement = $__export("CompileElement", (function() {
        var CompileElement = function CompileElement(element) {
          var compilationUnit = arguments[1] !== (void 0) ? arguments[1] : '';
          this.element = element;
          this._attrs = null;
          this._classList = null;
          this.textNodeBindings = null;
          this.propertyBindings = null;
          this.eventBindings = null;
          this.variableBindings = null;
          this.decoratorDirectives = null;
          this.viewportDirective = null;
          this.componentDirective = null;
          this.hasNestedView = false;
          this._allDirectives = null;
          this.isViewRoot = false;
          this.hasBindings = false;
          this.inheritedProtoView = null;
          this.inheritedProtoElementInjector = null;
          this.inheritedElementBinder = null;
          this.distanceToParentInjector = 0;
          this.distanceToParentBinder = 0;
          this.compileChildren = true;
          this.ignoreBindings = false;
          this.contentTagSelector = null;
          var tplDesc = assertionsEnabled() ? getElementDescription(element) : null;
          if (compilationUnit !== '') {
            this.elementDescription = compilationUnit;
            if (isPresent(tplDesc))
              this.elementDescription += ": " + tplDesc;
          } else {
            this.elementDescription = tplDesc;
          }
        };
        return ($traceurRuntime.createClass)(CompileElement, {
          refreshAttrs: function() {
            this._attrs = null;
          },
          attrs: function() {
            if (isBlank(this._attrs)) {
              this._attrs = DOM.attributeMap(this.element);
            }
            return this._attrs;
          },
          refreshClassList: function() {
            this._classList = null;
          },
          classList: function() {
            if (isBlank(this._classList)) {
              this._classList = ListWrapper.create();
              var elClassList = DOM.classList(this.element);
              for (var i = 0; i < elClassList.length; i++) {
                ListWrapper.push(this._classList, elClassList[i]);
              }
            }
            return this._classList;
          },
          addTextNodeBinding: function(indexInParent, expression) {
            if (isBlank(this.textNodeBindings)) {
              this.textNodeBindings = MapWrapper.create();
            }
            MapWrapper.set(this.textNodeBindings, indexInParent, expression);
          },
          addPropertyBinding: function(property, expression) {
            if (isBlank(this.propertyBindings)) {
              this.propertyBindings = MapWrapper.create();
            }
            MapWrapper.set(this.propertyBindings, dashCaseToCamelCase(property), expression);
          },
          addVariableBinding: function(variableName, variableValue) {
            if (isBlank(this.variableBindings)) {
              this.variableBindings = MapWrapper.create();
            }
            MapWrapper.set(this.variableBindings, variableValue, dashCaseToCamelCase(variableName));
          },
          addEventBinding: function(eventName, expression) {
            if (isBlank(this.eventBindings)) {
              this.eventBindings = MapWrapper.create();
            }
            MapWrapper.set(this.eventBindings, eventName, expression);
          },
          addAttribute: function(attributeName, attributeValue) {
            if (isBlank(this.attributes)) {
              this.attributes = MapWrapper.create();
            }
            MapWrapper.set(this.attributes, attributeName, attributeValue);
          },
          addDirective: function(directive) {
            var annotation = directive.annotation;
            this._allDirectives = null;
            if (annotation instanceof Decorator) {
              if (isBlank(this.decoratorDirectives)) {
                this.decoratorDirectives = ListWrapper.create();
              }
              ListWrapper.push(this.decoratorDirectives, directive);
              if (!annotation.compileChildren) {
                this.compileChildren = false;
              }
            } else if (annotation instanceof Viewport) {
              this.viewportDirective = directive;
            } else if (annotation instanceof Component) {
              this.componentDirective = directive;
              this.hasNestedView = true;
            } else if (annotation instanceof DynamicComponent) {
              this.componentDirective = directive;
            }
          },
          getAllDirectives: function() {
            if (this._allDirectives === null) {
              var directives = ListWrapper.create();
              if (isPresent(this.componentDirective)) {
                ListWrapper.push(directives, this.componentDirective);
              }
              if (isPresent(this.viewportDirective)) {
                ListWrapper.push(directives, this.viewportDirective);
              }
              if (isPresent(this.decoratorDirectives)) {
                directives = ListWrapper.concat(directives, this.decoratorDirectives);
              }
              this._allDirectives = directives;
            }
            return this._allDirectives;
          }
        }, {});
      }()));
      Object.defineProperty(CompileElement.prototype.addTextNodeBinding, "parameters", {get: function() {
          return [[int], [AST]];
        }});
      Object.defineProperty(CompileElement.prototype.addPropertyBinding, "parameters", {get: function() {
          return [[assert.type.string], [AST]];
        }});
      Object.defineProperty(CompileElement.prototype.addVariableBinding, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(CompileElement.prototype.addEventBinding, "parameters", {get: function() {
          return [[assert.type.string], [AST]];
        }});
      Object.defineProperty(CompileElement.prototype.addAttribute, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(CompileElement.prototype.addDirective, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
      Object.defineProperty(addDescriptionAttribute, "parameters", {get: function() {
          return [[StringJoiner], [assert.type.string], []];
        }});
    }
  };
});

System.register("angular2/src/render/dom/compiler/property_setter_factory", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/render/dom/util", "angular2/src/reflection/reflection"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/compiler/property_setter_factory";
  var StringWrapper,
      RegExpWrapper,
      BaseException,
      isPresent,
      isBlank,
      isString,
      stringify,
      ListWrapper,
      StringMapWrapper,
      DOM,
      camelCaseToDashCase,
      dashCaseToCamelCase,
      reflector,
      STYLE_SEPARATOR,
      propertySettersCache,
      innerHTMLSetterCache,
      ATTRIBUTE_PREFIX,
      attributeSettersCache,
      CLASS_PREFIX,
      classSettersCache,
      STYLE_PREFIX,
      styleSettersCache;
  function setterFactory(property) {
    var setterFn,
        styleParts,
        styleSuffix;
    if (StringWrapper.startsWith(property, ATTRIBUTE_PREFIX)) {
      setterFn = attributeSetterFactory(StringWrapper.substring(property, ATTRIBUTE_PREFIX.length));
    } else if (StringWrapper.startsWith(property, CLASS_PREFIX)) {
      setterFn = classSetterFactory(StringWrapper.substring(property, CLASS_PREFIX.length));
    } else if (StringWrapper.startsWith(property, STYLE_PREFIX)) {
      styleParts = property.split(STYLE_SEPARATOR);
      styleSuffix = styleParts.length > 2 ? ListWrapper.get(styleParts, 2) : '';
      setterFn = styleSetterFactory(ListWrapper.get(styleParts, 1), styleSuffix);
    } else if (StringWrapper.equals(property, 'innerHtml')) {
      if (isBlank(innerHTMLSetterCache)) {
        innerHTMLSetterCache = (function(el, value) {
          return DOM.setInnerHTML(el, value);
        });
      }
      setterFn = innerHTMLSetterCache;
    } else {
      property = resolvePropertyName(property);
      setterFn = StringMapWrapper.get(propertySettersCache, property);
      if (isBlank(setterFn)) {
        var propertySetterFn = reflector.setter(property);
        setterFn = function(receiver, value) {
          if (DOM.hasProperty(receiver, property)) {
            return propertySetterFn(receiver, value);
          }
        };
        StringMapWrapper.set(propertySettersCache, property, setterFn);
      }
    }
    return setterFn;
  }
  function _isValidAttributeValue(attrName, value) {
    if (attrName == "role") {
      return isString(value);
    } else {
      return isPresent(value);
    }
  }
  function attributeSetterFactory(attrName) {
    var setterFn = StringMapWrapper.get(attributeSettersCache, attrName);
    var dashCasedAttributeName;
    if (isBlank(setterFn)) {
      dashCasedAttributeName = camelCaseToDashCase(attrName);
      setterFn = function(element, value) {
        if (_isValidAttributeValue(dashCasedAttributeName, value)) {
          DOM.setAttribute(element, dashCasedAttributeName, stringify(value));
        } else {
          if (isPresent(value)) {
            throw new BaseException("Invalid " + dashCasedAttributeName + " attribute, only string values are allowed, got '" + stringify(value) + "'");
          }
          DOM.removeAttribute(element, dashCasedAttributeName);
        }
      };
      StringMapWrapper.set(attributeSettersCache, attrName, setterFn);
    }
    return setterFn;
  }
  function classSetterFactory(className) {
    var setterFn = StringMapWrapper.get(classSettersCache, className);
    var dashCasedClassName;
    if (isBlank(setterFn)) {
      dashCasedClassName = camelCaseToDashCase(className);
      setterFn = function(element, value) {
        if (value) {
          DOM.addClass(element, dashCasedClassName);
        } else {
          DOM.removeClass(element, dashCasedClassName);
        }
      };
      StringMapWrapper.set(classSettersCache, className, setterFn);
    }
    return setterFn;
  }
  function styleSetterFactory(styleName, styleSuffix) {
    var cacheKey = styleName + styleSuffix;
    var setterFn = StringMapWrapper.get(styleSettersCache, cacheKey);
    var dashCasedStyleName;
    if (isBlank(setterFn)) {
      dashCasedStyleName = camelCaseToDashCase(styleName);
      setterFn = function(element, value) {
        var valAsStr;
        if (isPresent(value)) {
          valAsStr = stringify(value);
          DOM.setStyle(element, dashCasedStyleName, valAsStr + styleSuffix);
        } else {
          DOM.removeStyle(element, dashCasedStyleName);
        }
      };
      StringMapWrapper.set(styleSettersCache, cacheKey, setterFn);
    }
    return setterFn;
  }
  function resolvePropertyName(attrName) {
    var mappedPropName = StringMapWrapper.get(DOM.attrToPropMap, attrName);
    return isPresent(mappedPropName) ? mappedPropName : attrName;
  }
  $__export("setterFactory", setterFactory);
  return {
    setters: [function($__m) {
      StringWrapper = $__m.StringWrapper;
      RegExpWrapper = $__m.RegExpWrapper;
      BaseException = $__m.BaseException;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      isString = $__m.isString;
      stringify = $__m.stringify;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      camelCaseToDashCase = $__m.camelCaseToDashCase;
      dashCaseToCamelCase = $__m.dashCaseToCamelCase;
    }, function($__m) {
      reflector = $__m.reflector;
    }],
    execute: function() {
      STYLE_SEPARATOR = '.';
      propertySettersCache = StringMapWrapper.create();
      Object.defineProperty(setterFactory, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      ATTRIBUTE_PREFIX = 'attr.';
      attributeSettersCache = StringMapWrapper.create();
      Object.defineProperty(_isValidAttributeValue, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any]];
        }});
      Object.defineProperty(attributeSetterFactory, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      CLASS_PREFIX = 'class.';
      classSettersCache = StringMapWrapper.create();
      Object.defineProperty(classSetterFactory, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      STYLE_PREFIX = 'style.';
      styleSettersCache = StringMapWrapper.create();
      Object.defineProperty(styleSetterFactory, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(resolvePropertyName, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/directive_parser", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/dom/dom_adapter", "angular2/src/render/dom/compiler/selector", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/annotations/annotations", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/directive_parser";
  var isPresent,
      isBlank,
      BaseException,
      assertionsEnabled,
      RegExpWrapper,
      List,
      MapWrapper,
      DOM,
      SelectorMatcher,
      CssSelector,
      DirectiveMetadata,
      DynamicComponent,
      Component,
      Viewport,
      CompileStep,
      CompileElement,
      CompileControl,
      PROPERTY_BINDING_REGEXP,
      DirectiveParser;
  function checkDirectiveValidity(directive, current, isTemplateElement) {
    var isComponent = directive.annotation instanceof Component || directive.annotation instanceof DynamicComponent;
    var alreadyHasComponent = isPresent(current.componentDirective);
    if (directive.annotation instanceof Viewport) {
      if (!isTemplateElement) {
        throw new BaseException("Viewport directives need to be placed on <template> elements or elements " + ("with template attribute - check " + current.elementDescription));
      } else if (isPresent(current.viewportDirective)) {
        throw new BaseException(("Only one viewport directive can be used per element - check " + current.elementDescription));
      }
    } else if (isTemplateElement) {
      throw new BaseException(("Only template directives are allowed on template elements - check " + current.elementDescription));
    } else if (isComponent && alreadyHasComponent) {
      throw new BaseException(("Multiple component directives not allowed on the same element - check " + current.elementDescription));
    }
    return directive;
  }
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      assertionsEnabled = $__m.assertionsEnabled;
      RegExpWrapper = $__m.RegExpWrapper;
    }, function($__m) {
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      SelectorMatcher = $__m.SelectorMatcher;
      CssSelector = $__m.CssSelector;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      DynamicComponent = $__m.DynamicComponent;
      Component = $__m.Component;
      Viewport = $__m.Viewport;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      PROPERTY_BINDING_REGEXP = RegExpWrapper.create('^ *([^\\s\\|]+)');
      DirectiveParser = $__export("DirectiveParser", (function($__super) {
        var DirectiveParser = function DirectiveParser(directives) {
          $traceurRuntime.superConstructor(DirectiveParser).call(this);
          var selector;
          this._selectorMatcher = new SelectorMatcher();
          for (var i = 0; i < directives.length; i++) {
            var directiveMetadata = directives[i];
            selector = CssSelector.parse(directiveMetadata.annotation.selector);
            this._selectorMatcher.addSelectables(selector, directiveMetadata);
          }
        };
        return ($traceurRuntime.createClass)(DirectiveParser, {process: function(parent, current, control) {
            var attrs = current.attrs();
            var classList = current.classList();
            var cssSelector = new CssSelector();
            var nodeName = DOM.nodeName(current.element);
            cssSelector.setElement(nodeName);
            for (var i = 0; i < classList.length; i++) {
              cssSelector.addClassName(classList[i]);
            }
            MapWrapper.forEach(attrs, (function(attrValue, attrName) {
              cssSelector.addAttribute(attrName, attrValue);
            }));
            var isTemplateElement = DOM.isTemplateElement(current.element);
            this._selectorMatcher.match(cssSelector, (function(selector, directive) {
              current.addDirective(checkDirectiveValidity(directive, current, isTemplateElement));
            }));
          }}, {}, $__super);
      }(CompileStep)));
      Object.defineProperty(DirectiveParser, "parameters", {get: function() {
          return [[assert.genericType(List, DirectiveMetadata)]];
        }});
      Object.defineProperty(DirectiveParser.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
    }
  };
});

System.register("angular2/src/render/dom/events/hammer_gestures", ["angular2/src/render/dom/events/hammer_common", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/render/dom/events/hammer_gestures";
  var HammerGesturesPluginCommon,
      isPresent,
      BaseException,
      HammerGesturesPlugin;
  return {
    setters: [function($__m) {
      HammerGesturesPluginCommon = $__m.HammerGesturesPluginCommon;
    }, function($__m) {
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
    }],
    execute: function() {
      HammerGesturesPlugin = $__export("HammerGesturesPlugin", (function($__super) {
        var HammerGesturesPlugin = function HammerGesturesPlugin() {
          $traceurRuntime.superConstructor(HammerGesturesPlugin).call(this);
        };
        return ($traceurRuntime.createClass)(HammerGesturesPlugin, {
          supports: function(eventName) {
            if (!$traceurRuntime.superGet(this, HammerGesturesPlugin.prototype, "supports").call(this, eventName))
              return false;
            if (!isPresent(window.Hammer)) {
              throw new BaseException(("Hammer.js is not loaded, can not bind " + eventName + " event"));
            }
            return true;
          },
          addEventListener: function(element, eventName, handler, shouldSupportBubble) {
            if (shouldSupportBubble)
              throw new BaseException('Hammer.js plugin does not support bubbling gestures.');
            var zone = this.manager.getZone();
            eventName = eventName.toLowerCase();
            zone.runOutsideAngular(function() {
              var mc = new Hammer(element);
              mc.get('pinch').set({enable: true});
              mc.get('rotate').set({enable: true});
              mc.on(eventName, function(eventObj) {
                zone.run(function() {
                  handler(eventObj);
                });
              });
            });
          }
        }, {}, $__super);
      }(HammerGesturesPluginCommon)));
      Object.defineProperty(HammerGesturesPlugin.prototype.supports, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(HammerGesturesPlugin.prototype.addEventListener, "parameters", {get: function() {
          return [[], [assert.type.string], [Function], [assert.type.boolean]];
        }});
    }
  };
});

System.register("angular2/src/core/testability/testability", ["angular2/di", "angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/src/core/testability/get_testability"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/testability/testability";
  var Injectable,
      DOM,
      Map,
      MapWrapper,
      List,
      ListWrapper,
      StringWrapper,
      isBlank,
      BaseException,
      getTestabilityModule,
      Testability,
      TestabilityRegistry;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      StringWrapper = $__m.StringWrapper;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
    }, function($__m) {
      getTestabilityModule = $__m;
    }],
    execute: function() {
      Testability = $__export("Testability", (function() {
        var Testability = function Testability() {
          this._pendingCount = 0;
          this._callbacks = ListWrapper.create();
        };
        return ($traceurRuntime.createClass)(Testability, {
          increaseCount: function() {
            var delta = arguments[0] !== (void 0) ? arguments[0] : 1;
            this._pendingCount += delta;
            if (this._pendingCount < 0) {
              throw new BaseException('pending async requests below zero');
            } else if (this._pendingCount == 0) {
              this._runCallbacks();
            }
            return this._pendingCount;
          },
          _runCallbacks: function() {
            while (this._callbacks.length !== 0) {
              ListWrapper.removeLast(this._callbacks)();
            }
          },
          whenStable: function(callback) {
            ListWrapper.push(this._callbacks, callback);
            if (this._pendingCount === 0) {
              this._runCallbacks();
            }
          },
          getPendingCount: function() {
            return this._pendingCount;
          },
          findBindings: function(using, binding, exactMatch) {
            return [];
          }
        }, {});
      }()));
      Object.defineProperty(Testability, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(Testability.prototype.increaseCount, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(Testability.prototype.whenStable, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(Testability.prototype.findBindings, "parameters", {get: function() {
          return [[], [assert.type.string], [assert.type.boolean]];
        }});
      TestabilityRegistry = $__export("TestabilityRegistry", (function() {
        var TestabilityRegistry = function TestabilityRegistry() {
          this._applications = MapWrapper.create();
          getTestabilityModule.GetTestability.addToWindow(this);
        };
        return ($traceurRuntime.createClass)(TestabilityRegistry, {
          registerApplication: function(token, testability) {
            MapWrapper.set(this._applications, token, testability);
          },
          findTestabilityInTree: function(elem) {
            if (elem == null) {
              return null;
            }
            if (MapWrapper.contains(this._applications, elem)) {
              return MapWrapper.get(this._applications, elem);
            }
            if (DOM.isShadowRoot(elem)) {
              return this.findTestabilityInTree(DOM.getHost(elem));
            }
            return this.findTestabilityInTree(DOM.parentElement(elem));
          }
        }, {});
      }()));
      Object.defineProperty(TestabilityRegistry, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(TestabilityRegistry.prototype.registerApplication, "parameters", {get: function() {
          return [[], [Testability]];
        }});
    }
  };
});

System.register("angular2/directives", ["angular2/src/directives/for", "angular2/src/directives/if", "angular2/src/directives/non_bindable", "angular2/src/directives/switch"], function($__export) {
  "";
  var __moduleName = "angular2/directives";
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  return {
    setters: [function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }],
    execute: function() {}
  };
});

System.register("angular2/src/forms/model", ["angular2/src/facade/lang", "angular2/src/facade/async", "angular2/src/facade/collection", "angular2/src/forms/validators"], function($__export) {
  "";
  var __moduleName = "angular2/src/forms/model";
  var isPresent,
      Observable,
      ObservableController,
      ObservableWrapper,
      StringMap,
      StringMapWrapper,
      ListWrapper,
      List,
      Validators,
      VALID,
      INVALID,
      AbstractControl,
      Control,
      ControlGroup,
      ControlArray;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
    }, function($__m) {
      Observable = $__m.Observable;
      ObservableController = $__m.ObservableController;
      ObservableWrapper = $__m.ObservableWrapper;
    }, function($__m) {
      StringMap = $__m.StringMap;
      StringMapWrapper = $__m.StringMapWrapper;
      ListWrapper = $__m.ListWrapper;
      List = $__m.List;
    }, function($__m) {
      Validators = $__m.Validators;
    }],
    execute: function() {
      VALID = $__export("VALID", "VALID");
      INVALID = $__export("INVALID", "INVALID");
      AbstractControl = $__export("AbstractControl", (function() {
        var AbstractControl = function AbstractControl(validator) {
          this.validator = validator;
          this._pristine = true;
        };
        return ($traceurRuntime.createClass)(AbstractControl, {
          get value() {
            return this._value;
          },
          get status() {
            return this._status;
          },
          get valid() {
            return this._status === VALID;
          },
          get errors() {
            return this._errors;
          },
          get pristine() {
            return this._pristine;
          },
          get dirty() {
            return !this.pristine;
          },
          setParent: function(parent) {
            this._parent = parent;
          },
          _updateParent: function() {
            if (isPresent(this._parent)) {
              this._parent._updateValue();
            }
          }
        }, {});
      }()));
      Object.defineProperty(AbstractControl, "parameters", {get: function() {
          return [[Function]];
        }});
      Control = $__export("Control", (function($__super) {
        var Control = function Control(value) {
          var validator = arguments[1] !== (void 0) ? arguments[1] : Validators.nullValidator;
          $traceurRuntime.superConstructor(Control).call(this, validator);
          this._setValueErrorsStatus(value);
          this._valueChangesController = ObservableWrapper.createController();
          this.valueChanges = ObservableWrapper.createObservable(this._valueChangesController);
        };
        return ($traceurRuntime.createClass)(Control, {
          updateValue: function(value) {
            this._setValueErrorsStatus(value);
            this._pristine = false;
            ObservableWrapper.callNext(this._valueChangesController, this._value);
            this._updateParent();
          },
          _setValueErrorsStatus: function(value) {
            this._value = value;
            this._errors = this.validator(this);
            this._status = isPresent(this._errors) ? INVALID : VALID;
          }
        }, {}, $__super);
      }(AbstractControl)));
      Object.defineProperty(Control, "parameters", {get: function() {
          return [[assert.type.any], [Function]];
        }});
      Object.defineProperty(Control.prototype.updateValue, "parameters", {get: function() {
          return [[assert.type.any]];
        }});
      ControlGroup = $__export("ControlGroup", (function($__super) {
        var ControlGroup = function ControlGroup(controls) {
          var optionals = arguments[1] !== (void 0) ? arguments[1] : null;
          var validator = arguments[2] !== (void 0) ? arguments[2] : Validators.group;
          $traceurRuntime.superConstructor(ControlGroup).call(this, validator);
          this.controls = controls;
          this._optionals = isPresent(optionals) ? optionals : {};
          this._valueChangesController = ObservableWrapper.createController();
          this.valueChanges = ObservableWrapper.createObservable(this._valueChangesController);
          this._setParentForControls();
          this._setValueErrorsStatus();
        };
        return ($traceurRuntime.createClass)(ControlGroup, {
          include: function(controlName) {
            StringMapWrapper.set(this._optionals, controlName, true);
            this._updateValue();
          },
          exclude: function(controlName) {
            StringMapWrapper.set(this._optionals, controlName, false);
            this._updateValue();
          },
          contains: function(controlName) {
            var c = StringMapWrapper.contains(this.controls, controlName);
            return c && this._included(controlName);
          },
          _setParentForControls: function() {
            var $__0 = this;
            StringMapWrapper.forEach(this.controls, (function(control, name) {
              control.setParent($__0);
            }));
          },
          _updateValue: function() {
            this._setValueErrorsStatus();
            this._pristine = false;
            ObservableWrapper.callNext(this._valueChangesController, this._value);
            this._updateParent();
          },
          _setValueErrorsStatus: function() {
            this._value = this._reduceValue();
            this._errors = this.validator(this);
            this._status = isPresent(this._errors) ? INVALID : VALID;
          },
          _reduceValue: function() {
            return this._reduceChildren({}, (function(acc, control, name) {
              acc[name] = control.value;
              return acc;
            }));
          },
          _reduceChildren: function(initValue, fn) {
            var $__0 = this;
            var res = initValue;
            StringMapWrapper.forEach(this.controls, (function(control, name) {
              if ($__0._included(name)) {
                res = fn(res, control, name);
              }
            }));
            return res;
          },
          _included: function(controlName) {
            var isOptional = StringMapWrapper.contains(this._optionals, controlName);
            return !isOptional || StringMapWrapper.get(this._optionals, controlName);
          }
        }, {}, $__super);
      }(AbstractControl)));
      Object.defineProperty(ControlGroup, "parameters", {get: function() {
          return [[StringMap], [StringMap], [Function]];
        }});
      Object.defineProperty(ControlGroup.prototype.include, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ControlGroup.prototype.exclude, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ControlGroup.prototype.contains, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(ControlGroup.prototype._reduceChildren, "parameters", {get: function() {
          return [[assert.type.any], [Function]];
        }});
      Object.defineProperty(ControlGroup.prototype._included, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      ControlArray = $__export("ControlArray", (function($__super) {
        var ControlArray = function ControlArray(controls) {
          var validator = arguments[1] !== (void 0) ? arguments[1] : Validators.array;
          $traceurRuntime.superConstructor(ControlArray).call(this, validator);
          this.controls = controls;
          this._valueChangesController = ObservableWrapper.createController();
          this.valueChanges = ObservableWrapper.createObservable(this._valueChangesController);
          this._setParentForControls();
          this._setValueErrorsStatus();
        };
        return ($traceurRuntime.createClass)(ControlArray, {
          at: function(index) {
            return this.controls[index];
          },
          push: function(control) {
            ListWrapper.push(this.controls, control);
            control.setParent(this);
            this._updateValue();
          },
          insert: function(index, control) {
            ListWrapper.insert(this.controls, index, control);
            control.setParent(this);
            this._updateValue();
          },
          removeAt: function(index) {
            ListWrapper.removeAt(this.controls, index);
            this._updateValue();
          },
          get length() {
            return this.controls.length;
          },
          _updateValue: function() {
            this._setValueErrorsStatus();
            this._pristine = false;
            ObservableWrapper.callNext(this._valueChangesController, this._value);
            this._updateParent();
          },
          _setParentForControls: function() {
            var $__0 = this;
            ListWrapper.forEach(this.controls, (function(control) {
              control.setParent($__0);
            }));
          },
          _setValueErrorsStatus: function() {
            this._value = ListWrapper.map(this.controls, (function(c) {
              return c.value;
            }));
            this._errors = this.validator(this);
            this._status = isPresent(this._errors) ? INVALID : VALID;
          }
        }, {}, $__super);
      }(AbstractControl)));
      Object.defineProperty(ControlArray, "parameters", {get: function() {
          return [[assert.genericType(List, AbstractControl)], [Function]];
        }});
      Object.defineProperty(ControlArray.prototype.at, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(ControlArray.prototype.push, "parameters", {get: function() {
          return [[AbstractControl]];
        }});
      Object.defineProperty(ControlArray.prototype.insert, "parameters", {get: function() {
          return [[assert.type.number], [AbstractControl]];
        }});
      Object.defineProperty(ControlArray.prototype.removeAt, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
    }
  };
});

System.register("angular2/src/reflection/reflection", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/reflector", "angular2/src/reflection/reflection_capabilities"], function($__export) {
  "";
  var __moduleName = "angular2/src/reflection/reflection";
  var Type,
      isPresent,
      List,
      ListWrapper,
      Reflector,
      ReflectionCapabilities,
      reflector;
  return {
    setters: [function($__m) {
      Type = $__m.Type;
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      Reflector = $__m.Reflector;
      $__export("Reflector", $__m.Reflector);
    }, function($__m) {
      ReflectionCapabilities = $__m.ReflectionCapabilities;
    }],
    execute: function() {
      reflector = $__export("reflector", new Reflector(new ReflectionCapabilities()));
    }
  };
});

System.register("angular2/src/change_detection/dynamic_change_detector", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/abstract_change_detector", "angular2/src/change_detection/pipes/pipe_registry", "angular2/src/change_detection/change_detection_util", "angular2/src/change_detection/proto_record", "angular2/src/change_detection/exceptions"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/dynamic_change_detector";
  var isPresent,
      isBlank,
      BaseException,
      FunctionWrapper,
      List,
      ListWrapper,
      MapWrapper,
      StringMapWrapper,
      AbstractChangeDetector,
      PipeRegistry,
      ChangeDetectionUtil,
      uninitialized,
      ProtoRecord,
      RECORD_TYPE_SELF,
      RECORD_TYPE_PROPERTY,
      RECORD_TYPE_LOCAL,
      RECORD_TYPE_INVOKE_METHOD,
      RECORD_TYPE_CONST,
      RECORD_TYPE_INVOKE_CLOSURE,
      RECORD_TYPE_PRIMITIVE_OP,
      RECORD_TYPE_KEYED_ACCESS,
      RECORD_TYPE_PIPE,
      RECORD_TYPE_BINDING_PIPE,
      RECORD_TYPE_INTERPOLATE,
      ExpressionChangedAfterItHasBeenChecked,
      ChangeDetectionError,
      DynamicChangeDetector;
  function isSame(a, b) {
    if (a === b)
      return true;
    if (a instanceof String && b instanceof String && a == b)
      return true;
    if ((a !== a) && (b !== b))
      return true;
    return false;
  }
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      FunctionWrapper = $__m.FunctionWrapper;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      AbstractChangeDetector = $__m.AbstractChangeDetector;
    }, function($__m) {
      PipeRegistry = $__m.PipeRegistry;
    }, function($__m) {
      ChangeDetectionUtil = $__m.ChangeDetectionUtil;
      uninitialized = $__m.uninitialized;
    }, function($__m) {
      ProtoRecord = $__m.ProtoRecord;
      RECORD_TYPE_SELF = $__m.RECORD_TYPE_SELF;
      RECORD_TYPE_PROPERTY = $__m.RECORD_TYPE_PROPERTY;
      RECORD_TYPE_LOCAL = $__m.RECORD_TYPE_LOCAL;
      RECORD_TYPE_INVOKE_METHOD = $__m.RECORD_TYPE_INVOKE_METHOD;
      RECORD_TYPE_CONST = $__m.RECORD_TYPE_CONST;
      RECORD_TYPE_INVOKE_CLOSURE = $__m.RECORD_TYPE_INVOKE_CLOSURE;
      RECORD_TYPE_PRIMITIVE_OP = $__m.RECORD_TYPE_PRIMITIVE_OP;
      RECORD_TYPE_KEYED_ACCESS = $__m.RECORD_TYPE_KEYED_ACCESS;
      RECORD_TYPE_PIPE = $__m.RECORD_TYPE_PIPE;
      RECORD_TYPE_BINDING_PIPE = $__m.RECORD_TYPE_BINDING_PIPE;
      RECORD_TYPE_INTERPOLATE = $__m.RECORD_TYPE_INTERPOLATE;
    }, function($__m) {
      ExpressionChangedAfterItHasBeenChecked = $__m.ExpressionChangedAfterItHasBeenChecked;
      ChangeDetectionError = $__m.ChangeDetectionError;
    }],
    execute: function() {
      DynamicChangeDetector = $__export("DynamicChangeDetector", (function($__super) {
        var DynamicChangeDetector = function DynamicChangeDetector(changeControlStrategy, dispatcher, pipeRegistry, protoRecords, directiveMementos) {
          $traceurRuntime.superConstructor(DynamicChangeDetector).call(this);
          this.dispatcher = dispatcher;
          this.pipeRegistry = pipeRegistry;
          this.values = ListWrapper.createFixedSize(protoRecords.length + 1);
          this.pipes = ListWrapper.createFixedSize(protoRecords.length + 1);
          this.prevContexts = ListWrapper.createFixedSize(protoRecords.length + 1);
          this.changes = ListWrapper.createFixedSize(protoRecords.length + 1);
          ListWrapper.fill(this.values, uninitialized);
          ListWrapper.fill(this.pipes, null);
          ListWrapper.fill(this.prevContexts, uninitialized);
          ListWrapper.fill(this.changes, false);
          this.locals = null;
          this.protos = protoRecords;
          this.directiveMementos = directiveMementos;
          this.changeControlStrategy = changeControlStrategy;
        };
        return ($traceurRuntime.createClass)(DynamicChangeDetector, {
          hydrate: function(context, locals) {
            this.mode = ChangeDetectionUtil.changeDetectionMode(this.changeControlStrategy);
            this.values[0] = context;
            this.locals = locals;
          },
          dehydrate: function() {
            this._destroyPipes();
            ListWrapper.fill(this.values, uninitialized);
            ListWrapper.fill(this.changes, false);
            ListWrapper.fill(this.pipes, null);
            ListWrapper.fill(this.prevContexts, uninitialized);
            this.locals = null;
          },
          _destroyPipes: function() {
            for (var i = 0; i < this.pipes.length; ++i) {
              if (isPresent(this.pipes[i])) {
                this.pipes[i].onDestroy();
              }
            }
          },
          hydrated: function() {
            return this.values[0] !== uninitialized;
          },
          detectChangesInRecords: function(throwOnChange) {
            var protos = this.protos;
            var updatedRecords = null;
            for (var i = 0; i < protos.length; ++i) {
              var proto = protos[i];
              var change = this._check(proto);
              if (isPresent(change)) {
                var record = ChangeDetectionUtil.changeRecord(proto.bindingMemento, change);
                updatedRecords = ChangeDetectionUtil.addRecord(updatedRecords, record);
              }
              if (proto.lastInDirective && isPresent(updatedRecords)) {
                if (throwOnChange)
                  ChangeDetectionUtil.throwOnChange(proto, updatedRecords[0]);
                this.dispatcher.onRecordChange(proto.directiveMemento, updatedRecords);
                updatedRecords = null;
              }
            }
          },
          callOnAllChangesDone: function() {
            var mementos = this.directiveMementos;
            for (var i = mementos.length - 1; i >= 0; --i) {
              var memento = mementos[i];
              if (memento.callOnAllChangesDone) {
                this.dispatcher.onAllChangesDone(memento);
              }
            }
          },
          _check: function(proto) {
            try {
              if (proto.mode === RECORD_TYPE_PIPE || proto.mode === RECORD_TYPE_BINDING_PIPE) {
                return this._pipeCheck(proto);
              } else {
                return this._referenceCheck(proto);
              }
            } catch (e) {
              throw new ChangeDetectionError(proto, e);
            }
          },
          _referenceCheck: function(proto) {
            if (this._pureFuncAndArgsDidNotChange(proto)) {
              this._setChanged(proto, false);
              return null;
            }
            var prevValue = this._readSelf(proto);
            var currValue = this._calculateCurrValue(proto);
            if (!isSame(prevValue, currValue)) {
              this._writeSelf(proto, currValue);
              this._setChanged(proto, true);
              if (proto.lastInBinding) {
                return ChangeDetectionUtil.simpleChange(prevValue, currValue);
              } else {
                return null;
              }
            } else {
              this._setChanged(proto, false);
              return null;
            }
          },
          _calculateCurrValue: function(proto) {
            switch (proto.mode) {
              case RECORD_TYPE_SELF:
                return this._readContext(proto);
              case RECORD_TYPE_CONST:
                return proto.funcOrValue;
              case RECORD_TYPE_PROPERTY:
                var context = this._readContext(proto);
                return proto.funcOrValue(context);
              case RECORD_TYPE_LOCAL:
                return this.locals.get(proto.name);
              case RECORD_TYPE_INVOKE_METHOD:
                var context = this._readContext(proto);
                var args = this._readArgs(proto);
                return proto.funcOrValue(context, args);
              case RECORD_TYPE_KEYED_ACCESS:
                var arg = this._readArgs(proto)[0];
                return this._readContext(proto)[arg];
              case RECORD_TYPE_INVOKE_CLOSURE:
                return FunctionWrapper.apply(this._readContext(proto), this._readArgs(proto));
              case RECORD_TYPE_INTERPOLATE:
              case RECORD_TYPE_PRIMITIVE_OP:
                return FunctionWrapper.apply(proto.funcOrValue, this._readArgs(proto));
              default:
                throw new BaseException(("Unknown operation " + proto.mode));
            }
          },
          _pipeCheck: function(proto) {
            var context = this._readContext(proto);
            var pipe = this._pipeFor(proto, context);
            var newValue = pipe.transform(context);
            if (!ChangeDetectionUtil.noChangeMarker(newValue)) {
              var prevValue = this._readSelf(proto);
              this._writeSelf(proto, newValue);
              this._setChanged(proto, true);
              if (proto.lastInBinding) {
                return ChangeDetectionUtil.simpleChange(prevValue, newValue);
              } else {
                return null;
              }
            } else {
              this._setChanged(proto, false);
              return null;
            }
          },
          _pipeFor: function(proto, context) {
            var storedPipe = this._readPipe(proto);
            if (isPresent(storedPipe) && storedPipe.supports(context)) {
              return storedPipe;
            }
            if (isPresent(storedPipe)) {
              storedPipe.onDestroy();
            }
            var bpc = proto.mode === RECORD_TYPE_BINDING_PIPE ? this.bindingPropagationConfig : null;
            var pipe = this.pipeRegistry.get(proto.name, context, bpc);
            this._writePipe(proto, pipe);
            return pipe;
          },
          _readContext: function(proto) {
            return this.values[proto.contextIndex];
          },
          _readSelf: function(proto) {
            return this.values[proto.selfIndex];
          },
          _writeSelf: function(proto, value) {
            this.values[proto.selfIndex] = value;
          },
          _readPipe: function(proto) {
            return this.pipes[proto.selfIndex];
          },
          _writePipe: function(proto, value) {
            this.pipes[proto.selfIndex] = value;
          },
          _setChanged: function(proto, value) {
            this.changes[proto.selfIndex] = value;
          },
          _pureFuncAndArgsDidNotChange: function(proto) {
            return proto.isPureFunction() && !this._argsChanged(proto);
          },
          _argsChanged: function(proto) {
            var args = proto.args;
            for (var i = 0; i < args.length; ++i) {
              if (this.changes[args[i]]) {
                return true;
              }
            }
            return false;
          },
          _readArgs: function(proto) {
            var res = ListWrapper.createFixedSize(proto.args.length);
            var args = proto.args;
            for (var i = 0; i < args.length; ++i) {
              res[i] = this.values[args[i]];
            }
            return res;
          }
        }, {}, $__super);
      }(AbstractChangeDetector)));
      Object.defineProperty(DynamicChangeDetector, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.any], [PipeRegistry], [assert.genericType(List, ProtoRecord)], [List]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype.hydrate, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype.detectChangesInRecords, "parameters", {get: function() {
          return [[assert.type.boolean]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._check, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._referenceCheck, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._calculateCurrValue, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._pipeCheck, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._pipeFor, "parameters", {get: function() {
          return [[ProtoRecord], []];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._readContext, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._readSelf, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._writeSelf, "parameters", {get: function() {
          return [[ProtoRecord], []];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._readPipe, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._writePipe, "parameters", {get: function() {
          return [[ProtoRecord], []];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._setChanged, "parameters", {get: function() {
          return [[ProtoRecord], [assert.type.boolean]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._pureFuncAndArgsDidNotChange, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._argsChanged, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
      Object.defineProperty(DynamicChangeDetector.prototype._readArgs, "parameters", {get: function() {
          return [[ProtoRecord]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/view_container", ["angular2/src/core/compiler/view", "angular2/src/dom/dom_adapter", "angular2/src/facade/collection", "angular2/src/facade/lang", "angular2/di", "angular2/src/core/compiler/element_injector", "angular2/src/render/dom/events/event_manager", "angular2/src/core/compiler/shadow_dom_emulation/light_dom"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/view_container";
  var viewModule,
      DOM,
      ListWrapper,
      MapWrapper,
      List,
      BaseException,
      Injector,
      eiModule,
      isPresent,
      isBlank,
      EventManager,
      LightDom,
      ViewContainer;
  return {
    setters: [function($__m) {
      viewModule = $__m;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      List = $__m.List;
    }, function($__m) {
      BaseException = $__m.BaseException;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
    }, function($__m) {
      Injector = $__m.Injector;
    }, function($__m) {
      eiModule = $__m;
    }, function($__m) {
      EventManager = $__m.EventManager;
    }, function($__m) {
      LightDom = $__m.LightDom;
    }],
    execute: function() {
      ViewContainer = $__export("ViewContainer", (function() {
        var ViewContainer = function ViewContainer(parentView, templateElement, defaultProtoView, elementInjector, eventManager) {
          var lightDom = arguments[5] !== (void 0) ? arguments[5] : null;
          this.parentView = parentView;
          this.templateElement = templateElement;
          this.defaultProtoView = defaultProtoView;
          this.elementInjector = elementInjector;
          this._lightDom = lightDom;
          this._views = [];
          this.appInjector = null;
          this.hostElementInjector = null;
          this.hostLightDom = null;
          this._eventManager = eventManager;
        };
        return ($traceurRuntime.createClass)(ViewContainer, {
          hydrate: function(appInjector, hostElementInjector, hostLightDom) {
            this.appInjector = appInjector;
            this.hostElementInjector = hostElementInjector;
            this.hostLightDom = hostLightDom;
          },
          dehydrate: function() {
            this.appInjector = null;
            this.hostElementInjector = null;
            this.hostLightDom = null;
            this.clear();
          },
          clear: function() {
            for (var i = this._views.length - 1; i >= 0; i--) {
              this.remove(i);
            }
          },
          get: function(index) {
            return this._views[index];
          },
          get length() {
            return this._views.length;
          },
          _siblingToInsertAfter: function(index) {
            if (index == 0)
              return this.templateElement;
            return ListWrapper.last(this._views[index - 1].nodes);
          },
          hydrated: function() {
            return isPresent(this.appInjector);
          },
          create: function() {
            var atIndex = arguments[0] !== (void 0) ? arguments[0] : -1;
            if (!this.hydrated())
              throw new BaseException('Cannot create views on a dehydrated ViewContainer');
            var newView = this.defaultProtoView.instantiate(this.hostElementInjector, this._eventManager);
            this.insert(newView, atIndex);
            newView.hydrate(this.appInjector, this.hostElementInjector, this.hostLightDom, this.parentView.context, this.parentView.locals);
            if (isPresent(this.hostLightDom)) {
              this.hostLightDom.redistribute();
            }
            return newView;
          },
          insert: function(view) {
            var atIndex = arguments[1] !== (void 0) ? arguments[1] : -1;
            if (atIndex == -1)
              atIndex = this._views.length;
            ListWrapper.insert(this._views, atIndex, view);
            if (isBlank(this._lightDom)) {
              ViewContainer.moveViewNodesAfterSibling(this._siblingToInsertAfter(atIndex), view);
            } else {
              this._lightDom.redistribute();
            }
            this.parentView.changeDetector.addChild(view.changeDetector);
            this._linkElementInjectors(view);
            return view;
          },
          remove: function() {
            var atIndex = arguments[0] !== (void 0) ? arguments[0] : -1;
            if (atIndex == -1)
              atIndex = this._views.length - 1;
            var view = this.detach(atIndex);
            view.dehydrate();
            this.defaultProtoView.returnToPool(view);
          },
          detach: function() {
            var atIndex = arguments[0] !== (void 0) ? arguments[0] : -1;
            if (atIndex == -1)
              atIndex = this._views.length - 1;
            var detachedView = this.get(atIndex);
            ListWrapper.removeAt(this._views, atIndex);
            if (isBlank(this._lightDom)) {
              ViewContainer.removeViewNodes(detachedView);
            } else {
              this._lightDom.redistribute();
            }
            if (isPresent(this.hostLightDom)) {
              this.hostLightDom.redistribute();
            }
            detachedView.changeDetector.remove();
            this._unlinkElementInjectors(detachedView);
            return detachedView;
          },
          contentTagContainers: function() {
            return this._views;
          },
          nodes: function() {
            var r = [];
            for (var i = 0; i < this._views.length; ++i) {
              r = ListWrapper.concat(r, this._views[i].nodes);
            }
            return r;
          },
          _linkElementInjectors: function(view) {
            for (var i = 0; i < view.rootElementInjectors.length; ++i) {
              view.rootElementInjectors[i].parent = this.elementInjector;
            }
          },
          _unlinkElementInjectors: function(view) {
            for (var i = 0; i < view.rootElementInjectors.length; ++i) {
              view.rootElementInjectors[i].parent = null;
            }
          }
        }, {
          moveViewNodesAfterSibling: function(sibling, view) {
            for (var i = view.nodes.length - 1; i >= 0; --i) {
              DOM.insertAfter(sibling, view.nodes[i]);
            }
          },
          removeViewNodes: function(view) {
            var len = view.nodes.length;
            if (len == 0)
              return ;
            var parent = view.nodes[0].parentNode;
            for (var i = len - 1; i >= 0; --i) {
              DOM.removeChild(parent, view.nodes[i]);
            }
          }
        });
      }()));
      Object.defineProperty(ViewContainer, "parameters", {get: function() {
          return [[viewModule.View], [], [viewModule.ProtoView], [eiModule.ElementInjector], [EventManager], []];
        }});
      Object.defineProperty(ViewContainer.prototype.hydrate, "parameters", {get: function() {
          return [[Injector], [eiModule.ElementInjector], [LightDom]];
        }});
      Object.defineProperty(ViewContainer.prototype.get, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(ViewContainer.prototype._siblingToInsertAfter, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/compile_step", ["angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/compile_step";
  var CompileElement,
      ccModule,
      CompileStep;
  return {
    setters: [function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      ccModule = $__m;
    }],
    execute: function() {
      CompileStep = $__export("CompileStep", (function() {
        var CompileStep = function CompileStep() {
          ;
        };
        return ($traceurRuntime.createClass)(CompileStep, {process: function(parent, current, control) {}}, {});
      }()));
      Object.defineProperty(CompileStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [ccModule.CompileControl]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/pipeline/default_steps", ["angular2/change_detection", "angular2/src/facade/collection", "angular2/src/core/compiler/pipeline/property_binding_parser", "angular2/src/core/compiler/pipeline/text_interpolation_parser", "angular2/src/core/compiler/pipeline/directive_parser", "angular2/src/core/compiler/pipeline/view_splitter", "angular2/src/core/compiler/pipeline/element_binding_marker", "angular2/src/core/compiler/pipeline/proto_view_builder", "angular2/src/core/compiler/pipeline/proto_element_injector_builder", "angular2/src/core/compiler/pipeline/element_binder_builder", "angular2/src/core/compiler/css_processor", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/compiler/shadow_dom_strategy"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/pipeline/default_steps";
  var ChangeDetection,
      Parser,
      List,
      ListWrapper,
      PropertyBindingParser,
      TextInterpolationParser,
      DirectiveParser,
      ViewSplitter,
      ElementBindingMarker,
      ProtoViewBuilder,
      ProtoElementInjectorBuilder,
      ElementBinderBuilder,
      CssProcessor,
      DirectiveMetadata,
      ShadowDomStrategy,
      EmulatedScopedShadowDomStrategy;
  function createDefaultSteps(changeDetection, parser, compiledComponent, directives, shadowDomStrategy, templateUrl, cssProcessor) {
    var steps = [new ViewSplitter(parser), cssProcessor.getCompileStep(compiledComponent, shadowDomStrategy, templateUrl), shadowDomStrategy.getTemplateCompileStep(compiledComponent), new PropertyBindingParser(parser), new DirectiveParser(directives), new TextInterpolationParser(parser), new ElementBindingMarker(), new ProtoViewBuilder(compiledComponent, changeDetection, shadowDomStrategy), new ProtoElementInjectorBuilder(), new ElementBinderBuilder(parser)];
    return steps;
  }
  $__export("createDefaultSteps", createDefaultSteps);
  return {
    setters: [function($__m) {
      ChangeDetection = $__m.ChangeDetection;
      Parser = $__m.Parser;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      PropertyBindingParser = $__m.PropertyBindingParser;
    }, function($__m) {
      TextInterpolationParser = $__m.TextInterpolationParser;
    }, function($__m) {
      DirectiveParser = $__m.DirectiveParser;
    }, function($__m) {
      ViewSplitter = $__m.ViewSplitter;
    }, function($__m) {
      ElementBindingMarker = $__m.ElementBindingMarker;
    }, function($__m) {
      ProtoViewBuilder = $__m.ProtoViewBuilder;
    }, function($__m) {
      ProtoElementInjectorBuilder = $__m.ProtoElementInjectorBuilder;
    }, function($__m) {
      ElementBinderBuilder = $__m.ElementBinderBuilder;
    }, function($__m) {
      CssProcessor = $__m.CssProcessor;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
      EmulatedScopedShadowDomStrategy = $__m.EmulatedScopedShadowDomStrategy;
    }],
    execute: function() {
      Object.defineProperty(createDefaultSteps, "parameters", {get: function() {
          return [[ChangeDetection], [Parser], [DirectiveMetadata], [assert.genericType(List, DirectiveMetadata)], [ShadowDomStrategy], [assert.type.string], [CssProcessor]];
        }});
    }
  };
});

System.register("angular2/forms", ["angular2/src/forms/model", "angular2/src/forms/directives", "angular2/src/forms/validators", "angular2/src/forms/validator_directives", "angular2/src/forms/form_builder"], function($__export) {
  "";
  var __moduleName = "angular2/forms";
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  return {
    setters: [function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }],
    execute: function() {}
  };
});

System.register("angular2/src/di/binding", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/reflection/reflection", "angular2/src/di/key", "angular2/src/di/annotations", "angular2/src/di/exceptions"], function($__export) {
  "";
  var __moduleName = "angular2/src/di/binding";
  var Type,
      isBlank,
      isPresent,
      List,
      MapWrapper,
      ListWrapper,
      reflector,
      Key,
      Inject,
      InjectLazy,
      InjectPromise,
      Optional,
      DependencyAnnotation,
      NoAnnotationError,
      Dependency,
      Binding,
      BindingBuilder;
  function bind(token) {
    return new BindingBuilder(token);
  }
  function _dependenciesFor(typeOrFunc) {
    var params = reflector.parameters(typeOrFunc);
    if (isBlank(params))
      return [];
    if (ListWrapper.any(params, (function(p) {
      return isBlank(p);
    })))
      throw new NoAnnotationError(typeOrFunc);
    return ListWrapper.map(params, (function(p) {
      return _extractToken(typeOrFunc, p);
    }));
  }
  function _extractToken(typeOrFunc, annotations) {
    var depProps = [];
    var token = null;
    var optional = false;
    var lazy = false;
    var asPromise = false;
    for (var i = 0; i < annotations.length; ++i) {
      var paramAnnotation = annotations[i];
      if (paramAnnotation instanceof Type) {
        token = paramAnnotation;
      } else if (paramAnnotation instanceof Inject) {
        token = paramAnnotation.token;
      } else if (paramAnnotation instanceof InjectPromise) {
        token = paramAnnotation.token;
        asPromise = true;
      } else if (paramAnnotation instanceof InjectLazy) {
        token = paramAnnotation.token;
        lazy = true;
      } else if (paramAnnotation instanceof Optional) {
        optional = true;
      } else if (paramAnnotation instanceof DependencyAnnotation) {
        if (isPresent(paramAnnotation.token)) {
          token = paramAnnotation.token;
        }
        ListWrapper.push(depProps, paramAnnotation);
      } else if (paramAnnotation.name === "string") {
        token = paramAnnotation;
      }
    }
    if (isPresent(token)) {
      return _createDependency(token, asPromise, lazy, optional, depProps);
    } else {
      throw new NoAnnotationError(typeOrFunc);
    }
  }
  function _createDependency(token, asPromise, lazy, optional, depProps) {
    return new Dependency(Key.get(token), asPromise, lazy, optional, depProps);
  }
  $__export("bind", bind);
  return {
    setters: [function($__m) {
      Type = $__m.Type;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
    }, function($__m) {
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      reflector = $__m.reflector;
    }, function($__m) {
      Key = $__m.Key;
    }, function($__m) {
      Inject = $__m.Inject;
      InjectLazy = $__m.InjectLazy;
      InjectPromise = $__m.InjectPromise;
      Optional = $__m.Optional;
      DependencyAnnotation = $__m.DependencyAnnotation;
    }, function($__m) {
      NoAnnotationError = $__m.NoAnnotationError;
    }],
    execute: function() {
      Dependency = $__export("Dependency", (function() {
        var Dependency = function Dependency(key, asPromise, lazy, optional, properties) {
          this.key = key;
          this.asPromise = asPromise;
          this.lazy = lazy;
          this.optional = optional;
          this.properties = properties;
        };
        return ($traceurRuntime.createClass)(Dependency, {}, {fromKey: function(key) {
            return new Dependency(key, false, false, false, []);
          }});
      }()));
      Object.defineProperty(Dependency, "parameters", {get: function() {
          return [[Key], [assert.type.boolean], [assert.type.boolean], [assert.type.boolean], [List]];
        }});
      Object.defineProperty(Dependency.fromKey, "parameters", {get: function() {
          return [[Key]];
        }});
      Binding = $__export("Binding", (function() {
        var Binding = function Binding(key, factory, dependencies, providedAsPromise) {
          this.key = key;
          this.factory = factory;
          this.dependencies = dependencies;
          this.providedAsPromise = providedAsPromise;
        };
        return ($traceurRuntime.createClass)(Binding, {}, {});
      }()));
      Object.defineProperty(Binding, "parameters", {get: function() {
          return [[Key], [Function], [List], [assert.type.boolean]];
        }});
      BindingBuilder = $__export("BindingBuilder", (function() {
        var BindingBuilder = function BindingBuilder(token) {
          this.token = token;
        };
        return ($traceurRuntime.createClass)(BindingBuilder, {
          toClass: function(type) {
            return new Binding(Key.get(this.token), reflector.factory(type), _dependenciesFor(type), false);
          },
          toValue: function(value) {
            return new Binding(Key.get(this.token), (function() {
              return value;
            }), [], false);
          },
          toAlias: function(aliasToken) {
            return new Binding(Key.get(this.token), (function(aliasInstance) {
              return aliasInstance;
            }), [Dependency.fromKey(Key.get(aliasToken))], false);
          },
          toFactory: function(factoryFunction) {
            var dependencies = arguments[1] !== (void 0) ? arguments[1] : null;
            return new Binding(Key.get(this.token), factoryFunction, this._constructDependencies(factoryFunction, dependencies), false);
          },
          toAsyncFactory: function(factoryFunction) {
            var dependencies = arguments[1] !== (void 0) ? arguments[1] : null;
            return new Binding(Key.get(this.token), factoryFunction, this._constructDependencies(factoryFunction, dependencies), true);
          },
          _constructDependencies: function(factoryFunction, dependencies) {
            return isBlank(dependencies) ? _dependenciesFor(factoryFunction) : ListWrapper.map(dependencies, (function(t) {
              return Dependency.fromKey(Key.get(t));
            }));
          }
        }, {});
      }()));
      Object.defineProperty(BindingBuilder.prototype.toClass, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(BindingBuilder.prototype.toFactory, "parameters", {get: function() {
          return [[Function], [List]];
        }});
      Object.defineProperty(BindingBuilder.prototype.toAsyncFactory, "parameters", {get: function() {
          return [[Function], [List]];
        }});
      Object.defineProperty(BindingBuilder.prototype._constructDependencies, "parameters", {get: function() {
          return [[Function], [List]];
        }});
    }
  };
});

System.register("angular2/src/change_detection/proto_change_detector", ["angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/change_detection/parser/ast", "angular2/src/change_detection/interfaces", "angular2/src/change_detection/change_detection_util", "angular2/src/change_detection/dynamic_change_detector", "angular2/src/change_detection/change_detection_jit_generator", "angular2/src/change_detection/pipes/pipe_registry", "angular2/src/change_detection/coalesce", "angular2/src/change_detection/proto_record"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/proto_change_detector";
  var isPresent,
      isBlank,
      BaseException,
      Type,
      isString,
      List,
      ListWrapper,
      MapWrapper,
      StringMapWrapper,
      AccessMember,
      Assignment,
      AST,
      ASTWithSource,
      AstVisitor,
      Binary,
      Chain,
      Conditional,
      Pipe,
      FunctionCall,
      ImplicitReceiver,
      Interpolation,
      KeyedAccess,
      LiteralArray,
      LiteralMap,
      LiteralPrimitive,
      MethodCall,
      PrefixNot,
      ChangeRecord,
      ChangeDispatcher,
      ChangeDetector,
      ProtoChangeDetector,
      ChangeDetectionUtil,
      DynamicChangeDetector,
      ChangeDetectorJITGenerator,
      PipeRegistry,
      coalesce,
      ProtoRecord,
      RECORD_TYPE_SELF,
      RECORD_TYPE_PROPERTY,
      RECORD_TYPE_LOCAL,
      RECORD_TYPE_INVOKE_METHOD,
      RECORD_TYPE_CONST,
      RECORD_TYPE_INVOKE_CLOSURE,
      RECORD_TYPE_PRIMITIVE_OP,
      RECORD_TYPE_KEYED_ACCESS,
      RECORD_TYPE_PIPE,
      RECORD_TYPE_BINDING_PIPE,
      RECORD_TYPE_INTERPOLATE,
      BindingRecord,
      DynamicProtoChangeDetector,
      _jitProtoChangeDetectorClassCounter,
      JitProtoChangeDetector,
      ProtoRecordBuilder,
      _ConvertAstIntoProtoRecords;
  function _arrayFn(length) {
    switch (length) {
      case 0:
        return ChangeDetectionUtil.arrayFn0;
      case 1:
        return ChangeDetectionUtil.arrayFn1;
      case 2:
        return ChangeDetectionUtil.arrayFn2;
      case 3:
        return ChangeDetectionUtil.arrayFn3;
      case 4:
        return ChangeDetectionUtil.arrayFn4;
      case 5:
        return ChangeDetectionUtil.arrayFn5;
      case 6:
        return ChangeDetectionUtil.arrayFn6;
      case 7:
        return ChangeDetectionUtil.arrayFn7;
      case 8:
        return ChangeDetectionUtil.arrayFn8;
      case 9:
        return ChangeDetectionUtil.arrayFn9;
      default:
        throw new BaseException("Does not support literal maps with more than 9 elements");
    }
  }
  function _mapPrimitiveName(keys) {
    var stringifiedKeys = ListWrapper.join(ListWrapper.map(keys, (function(k) {
      return isString(k) ? ("\"" + k + "\"") : ("" + k);
    })), ", ");
    return ("mapFn([" + stringifiedKeys + "])");
  }
  function _operationToPrimitiveName(operation) {
    switch (operation) {
      case '+':
        return "operation_add";
      case '-':
        return "operation_subtract";
      case '*':
        return "operation_multiply";
      case '/':
        return "operation_divide";
      case '%':
        return "operation_remainder";
      case '==':
        return "operation_equals";
      case '!=':
        return "operation_not_equals";
      case '<':
        return "operation_less_then";
      case '>':
        return "operation_greater_then";
      case '<=':
        return "operation_less_or_equals_then";
      case '>=':
        return "operation_greater_or_equals_then";
      case '&&':
        return "operation_logical_and";
      case '||':
        return "operation_logical_or";
      default:
        throw new BaseException(("Unsupported operation " + operation));
    }
  }
  function _operationToFunction(operation) {
    switch (operation) {
      case '+':
        return ChangeDetectionUtil.operation_add;
      case '-':
        return ChangeDetectionUtil.operation_subtract;
      case '*':
        return ChangeDetectionUtil.operation_multiply;
      case '/':
        return ChangeDetectionUtil.operation_divide;
      case '%':
        return ChangeDetectionUtil.operation_remainder;
      case '==':
        return ChangeDetectionUtil.operation_equals;
      case '!=':
        return ChangeDetectionUtil.operation_not_equals;
      case '<':
        return ChangeDetectionUtil.operation_less_then;
      case '>':
        return ChangeDetectionUtil.operation_greater_then;
      case '<=':
        return ChangeDetectionUtil.operation_less_or_equals_then;
      case '>=':
        return ChangeDetectionUtil.operation_greater_or_equals_then;
      case '&&':
        return ChangeDetectionUtil.operation_logical_and;
      case '||':
        return ChangeDetectionUtil.operation_logical_or;
      default:
        throw new BaseException(("Unsupported operation " + operation));
    }
  }
  function s(v) {
    return isPresent(v) ? ("" + v) : '';
  }
  function _interpolationFn(strings) {
    var length = strings.length;
    var c0 = length > 0 ? strings[0] : null;
    var c1 = length > 1 ? strings[1] : null;
    var c2 = length > 2 ? strings[2] : null;
    var c3 = length > 3 ? strings[3] : null;
    var c4 = length > 4 ? strings[4] : null;
    var c5 = length > 5 ? strings[5] : null;
    var c6 = length > 6 ? strings[6] : null;
    var c7 = length > 7 ? strings[7] : null;
    var c8 = length > 8 ? strings[8] : null;
    var c9 = length > 9 ? strings[9] : null;
    switch (length - 1) {
      case 1:
        return (function(a1) {
          return c0 + s(a1) + c1;
        });
      case 2:
        return (function(a1, a2) {
          return c0 + s(a1) + c1 + s(a2) + c2;
        });
      case 3:
        return (function(a1, a2, a3) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3;
        });
      case 4:
        return (function(a1, a2, a3, a4) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4;
        });
      case 5:
        return (function(a1, a2, a3, a4, a5) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4 + s(a5) + c5;
        });
      case 6:
        return (function(a1, a2, a3, a4, a5, a6) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4 + s(a5) + c5 + s(a6) + c6;
        });
      case 7:
        return (function(a1, a2, a3, a4, a5, a6, a7) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4 + s(a5) + c5 + s(a6) + c6 + s(a7) + c7;
        });
      case 8:
        return (function(a1, a2, a3, a4, a5, a6, a7, a8) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4 + s(a5) + c5 + s(a6) + c6 + s(a7) + c7 + s(a8) + c8;
        });
      case 9:
        return (function(a1, a2, a3, a4, a5, a6, a7, a8, a9) {
          return c0 + s(a1) + c1 + s(a2) + c2 + s(a3) + c3 + s(a4) + c4 + s(a5) + c5 + s(a6) + c6 + s(a7) + c7 + s(a8) + c8 + s(a9) + c9;
        });
      default:
        throw new BaseException("Does not support more than 9 expressions");
    }
  }
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
      Type = $__m.Type;
      isString = $__m.isString;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      StringMapWrapper = $__m.StringMapWrapper;
    }, function($__m) {
      AccessMember = $__m.AccessMember;
      Assignment = $__m.Assignment;
      AST = $__m.AST;
      ASTWithSource = $__m.ASTWithSource;
      AstVisitor = $__m.AstVisitor;
      Binary = $__m.Binary;
      Chain = $__m.Chain;
      Conditional = $__m.Conditional;
      Pipe = $__m.Pipe;
      FunctionCall = $__m.FunctionCall;
      ImplicitReceiver = $__m.ImplicitReceiver;
      Interpolation = $__m.Interpolation;
      KeyedAccess = $__m.KeyedAccess;
      LiteralArray = $__m.LiteralArray;
      LiteralMap = $__m.LiteralMap;
      LiteralPrimitive = $__m.LiteralPrimitive;
      MethodCall = $__m.MethodCall;
      PrefixNot = $__m.PrefixNot;
    }, function($__m) {
      ChangeRecord = $__m.ChangeRecord;
      ChangeDispatcher = $__m.ChangeDispatcher;
      ChangeDetector = $__m.ChangeDetector;
      ProtoChangeDetector = $__m.ProtoChangeDetector;
    }, function($__m) {
      ChangeDetectionUtil = $__m.ChangeDetectionUtil;
    }, function($__m) {
      DynamicChangeDetector = $__m.DynamicChangeDetector;
    }, function($__m) {
      ChangeDetectorJITGenerator = $__m.ChangeDetectorJITGenerator;
    }, function($__m) {
      PipeRegistry = $__m.PipeRegistry;
    }, function($__m) {
      coalesce = $__m.coalesce;
    }, function($__m) {
      ProtoRecord = $__m.ProtoRecord;
      RECORD_TYPE_SELF = $__m.RECORD_TYPE_SELF;
      RECORD_TYPE_PROPERTY = $__m.RECORD_TYPE_PROPERTY;
      RECORD_TYPE_LOCAL = $__m.RECORD_TYPE_LOCAL;
      RECORD_TYPE_INVOKE_METHOD = $__m.RECORD_TYPE_INVOKE_METHOD;
      RECORD_TYPE_CONST = $__m.RECORD_TYPE_CONST;
      RECORD_TYPE_INVOKE_CLOSURE = $__m.RECORD_TYPE_INVOKE_CLOSURE;
      RECORD_TYPE_PRIMITIVE_OP = $__m.RECORD_TYPE_PRIMITIVE_OP;
      RECORD_TYPE_KEYED_ACCESS = $__m.RECORD_TYPE_KEYED_ACCESS;
      RECORD_TYPE_PIPE = $__m.RECORD_TYPE_PIPE;
      RECORD_TYPE_BINDING_PIPE = $__m.RECORD_TYPE_BINDING_PIPE;
      RECORD_TYPE_INTERPOLATE = $__m.RECORD_TYPE_INTERPOLATE;
    }],
    execute: function() {
      BindingRecord = $__export("BindingRecord", (function() {
        var BindingRecord = function BindingRecord(ast, bindingMemento, directiveMemento) {
          this.ast = ast;
          this.bindingMemento = bindingMemento;
          this.directiveMemento = directiveMemento;
        };
        return ($traceurRuntime.createClass)(BindingRecord, {}, {});
      }()));
      Object.defineProperty(BindingRecord, "parameters", {get: function() {
          return [[AST], [assert.type.any], [assert.type.any]];
        }});
      DynamicProtoChangeDetector = $__export("DynamicProtoChangeDetector", (function($__super) {
        var DynamicProtoChangeDetector = function DynamicProtoChangeDetector(pipeRegistry, changeControlStrategy) {
          $traceurRuntime.superConstructor(DynamicProtoChangeDetector).call(this);
          this._pipeRegistry = pipeRegistry;
          this._changeControlStrategy = changeControlStrategy;
        };
        return ($traceurRuntime.createClass)(DynamicProtoChangeDetector, {
          instantiate: function(dispatcher, bindingRecords, variableBindings, directiveMementos) {
            this._createRecordsIfNecessary(bindingRecords, variableBindings);
            return new DynamicChangeDetector(this._changeControlStrategy, dispatcher, this._pipeRegistry, this._records, directiveMementos);
          },
          _createRecordsIfNecessary: function(bindingRecords, variableBindings) {
            if (isBlank(this._records)) {
              var recordBuilder = new ProtoRecordBuilder();
              ListWrapper.forEach(bindingRecords, (function(r) {
                recordBuilder.addAst(r.ast, r.bindingMemento, r.directiveMemento, variableBindings);
              }));
              this._records = coalesce(recordBuilder.records);
            }
          }
        }, {}, $__super);
      }(ProtoChangeDetector)));
      Object.defineProperty(DynamicProtoChangeDetector, "parameters", {get: function() {
          return [[PipeRegistry], [assert.type.string]];
        }});
      Object.defineProperty(DynamicProtoChangeDetector.prototype.instantiate, "parameters", {get: function() {
          return [[assert.type.any], [List], [List], [List]];
        }});
      Object.defineProperty(DynamicProtoChangeDetector.prototype._createRecordsIfNecessary, "parameters", {get: function() {
          return [[List], [List]];
        }});
      _jitProtoChangeDetectorClassCounter = 0;
      JitProtoChangeDetector = $__export("JitProtoChangeDetector", (function($__super) {
        var JitProtoChangeDetector = function JitProtoChangeDetector(pipeRegistry, changeControlStrategy) {
          $traceurRuntime.superConstructor(JitProtoChangeDetector).call(this);
          this._pipeRegistry = pipeRegistry;
          this._factory = null;
          this._changeControlStrategy = changeControlStrategy;
        };
        return ($traceurRuntime.createClass)(JitProtoChangeDetector, {
          instantiate: function(dispatcher, bindingRecords, variableBindings, directiveMementos) {
            this._createFactoryIfNecessary(bindingRecords, variableBindings, directiveMementos);
            return this._factory(dispatcher, this._pipeRegistry);
          },
          _createFactoryIfNecessary: function(bindingRecords, variableBindings, directiveMementos) {
            if (isBlank(this._factory)) {
              var recordBuilder = new ProtoRecordBuilder();
              ListWrapper.forEach(bindingRecords, (function(r) {
                recordBuilder.addAst(r.ast, r.bindingMemento, r.directiveMemento, variableBindings);
              }));
              var c = _jitProtoChangeDetectorClassCounter++;
              var records = coalesce(recordBuilder.records);
              var typeName = ("ChangeDetector" + c);
              this._factory = new ChangeDetectorJITGenerator(typeName, this._changeControlStrategy, records, directiveMementos).generate();
            }
          }
        }, {}, $__super);
      }(ProtoChangeDetector)));
      Object.defineProperty(JitProtoChangeDetector, "parameters", {get: function() {
          return [[], [assert.type.string]];
        }});
      Object.defineProperty(JitProtoChangeDetector.prototype.instantiate, "parameters", {get: function() {
          return [[assert.type.any], [List], [List], [List]];
        }});
      Object.defineProperty(JitProtoChangeDetector.prototype._createFactoryIfNecessary, "parameters", {get: function() {
          return [[List], [List], [List]];
        }});
      ProtoRecordBuilder = (function() {
        var ProtoRecordBuilder = function ProtoRecordBuilder() {
          this.records = [];
        };
        return ($traceurRuntime.createClass)(ProtoRecordBuilder, {addAst: function(ast, bindingMemento) {
            var directiveMemento = arguments[2] !== (void 0) ? arguments[2] : null;
            var variableBindings = arguments[3] !== (void 0) ? arguments[3] : null;
            var last = ListWrapper.last(this.records);
            if (isPresent(last) && last.directiveMemento == directiveMemento) {
              last.lastInDirective = false;
            }
            var pr = _ConvertAstIntoProtoRecords.convert(ast, bindingMemento, directiveMemento, this.records.length, variableBindings);
            if (!ListWrapper.isEmpty(pr)) {
              var last = ListWrapper.last(pr);
              last.lastInBinding = true;
              last.lastInDirective = true;
              this.records = ListWrapper.concat(this.records, pr);
            }
          }}, {});
      }());
      Object.defineProperty(ProtoRecordBuilder.prototype.addAst, "parameters", {get: function() {
          return [[AST], [assert.type.any], [assert.type.any], [List]];
        }});
      _ConvertAstIntoProtoRecords = (function() {
        var _ConvertAstIntoProtoRecords = function _ConvertAstIntoProtoRecords(bindingMemento, directiveMemento, contextIndex, expressionAsString, variableBindings) {
          this.protoRecords = [];
          this.bindingMemento = bindingMemento;
          this.directiveMemento = directiveMemento;
          this.contextIndex = contextIndex;
          this.expressionAsString = expressionAsString;
          this.variableBindings = variableBindings;
        };
        return ($traceurRuntime.createClass)(_ConvertAstIntoProtoRecords, {
          visitImplicitReceiver: function(ast) {
            return 0;
          },
          visitInterpolation: function(ast) {
            var args = this._visitAll(ast.expressions);
            return this._addRecord(RECORD_TYPE_INTERPOLATE, "interpolate", _interpolationFn(ast.strings), args, ast.strings, 0);
          },
          visitLiteralPrimitive: function(ast) {
            return this._addRecord(RECORD_TYPE_CONST, "literal", ast.value, [], null, 0);
          },
          visitAccessMember: function(ast) {
            var receiver = ast.receiver.visit(this);
            if (isPresent(this.variableBindings) && ListWrapper.contains(this.variableBindings, ast.name)) {
              return this._addRecord(RECORD_TYPE_LOCAL, ast.name, ast.name, [], null, receiver);
            } else {
              return this._addRecord(RECORD_TYPE_PROPERTY, ast.name, ast.getter, [], null, receiver);
            }
          },
          visitMethodCall: function(ast) {
            ;
            var receiver = ast.receiver.visit(this);
            var args = this._visitAll(ast.args);
            if (isPresent(this.variableBindings) && ListWrapper.contains(this.variableBindings, ast.name)) {
              var target = this._addRecord(RECORD_TYPE_LOCAL, ast.name, ast.name, [], null, receiver);
              return this._addRecord(RECORD_TYPE_INVOKE_CLOSURE, "closure", null, args, null, target);
            } else {
              return this._addRecord(RECORD_TYPE_INVOKE_METHOD, ast.name, ast.fn, args, null, receiver);
            }
          },
          visitFunctionCall: function(ast) {
            var target = ast.target.visit(this);
            var args = this._visitAll(ast.args);
            return this._addRecord(RECORD_TYPE_INVOKE_CLOSURE, "closure", null, args, null, target);
          },
          visitLiteralArray: function(ast) {
            var primitiveName = ("arrayFn" + ast.expressions.length);
            return this._addRecord(RECORD_TYPE_PRIMITIVE_OP, primitiveName, _arrayFn(ast.expressions.length), this._visitAll(ast.expressions), null, 0);
          },
          visitLiteralMap: function(ast) {
            return this._addRecord(RECORD_TYPE_PRIMITIVE_OP, _mapPrimitiveName(ast.keys), ChangeDetectionUtil.mapFn(ast.keys), this._visitAll(ast.values), null, 0);
          },
          visitBinary: function(ast) {
            var left = ast.left.visit(this);
            var right = ast.right.visit(this);
            return this._addRecord(RECORD_TYPE_PRIMITIVE_OP, _operationToPrimitiveName(ast.operation), _operationToFunction(ast.operation), [left, right], null, 0);
          },
          visitPrefixNot: function(ast) {
            var exp = ast.expression.visit(this);
            return this._addRecord(RECORD_TYPE_PRIMITIVE_OP, "operation_negate", ChangeDetectionUtil.operation_negate, [exp], null, 0);
          },
          visitConditional: function(ast) {
            var c = ast.condition.visit(this);
            var t = ast.trueExp.visit(this);
            var f = ast.falseExp.visit(this);
            return this._addRecord(RECORD_TYPE_PRIMITIVE_OP, "cond", ChangeDetectionUtil.cond, [c, t, f], null, 0);
          },
          visitPipe: function(ast) {
            var value = ast.exp.visit(this);
            var type = ast.inBinding ? RECORD_TYPE_BINDING_PIPE : RECORD_TYPE_PIPE;
            return this._addRecord(type, ast.name, ast.name, [], null, value);
          },
          visitKeyedAccess: function(ast) {
            var obj = ast.obj.visit(this);
            var key = ast.key.visit(this);
            return this._addRecord(RECORD_TYPE_KEYED_ACCESS, "keyedAccess", ChangeDetectionUtil.keyedAccess, [key], null, obj);
          },
          _visitAll: function(asts) {
            var res = ListWrapper.createFixedSize(asts.length);
            for (var i = 0; i < asts.length; ++i) {
              res[i] = asts[i].visit(this);
            }
            return res;
          },
          _addRecord: function(type, name, funcOrValue, args, fixedArgs, context) {
            var selfIndex = ++this.contextIndex;
            ListWrapper.push(this.protoRecords, new ProtoRecord(type, name, funcOrValue, args, fixedArgs, context, selfIndex, this.bindingMemento, this.directiveMemento, this.expressionAsString, false, false));
            return selfIndex;
          }
        }, {convert: function(ast, bindingMemento, directiveMemento, contextIndex, variableBindings) {
            var c = new _ConvertAstIntoProtoRecords(bindingMemento, directiveMemento, contextIndex, ast.toString(), variableBindings);
            ast.visit(c);
            return c.protoRecords;
          }});
      }());
      Object.defineProperty(_ConvertAstIntoProtoRecords, "parameters", {get: function() {
          return [[assert.type.any], [assert.type.any], [assert.type.number], [assert.type.string], [List]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.convert, "parameters", {get: function() {
          return [[AST], [assert.type.any], [assert.type.any], [assert.type.number], [List]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitImplicitReceiver, "parameters", {get: function() {
          return [[ImplicitReceiver]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitInterpolation, "parameters", {get: function() {
          return [[Interpolation]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitLiteralPrimitive, "parameters", {get: function() {
          return [[LiteralPrimitive]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitAccessMember, "parameters", {get: function() {
          return [[AccessMember]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitMethodCall, "parameters", {get: function() {
          return [[MethodCall]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitFunctionCall, "parameters", {get: function() {
          return [[FunctionCall]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitLiteralArray, "parameters", {get: function() {
          return [[LiteralArray]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitLiteralMap, "parameters", {get: function() {
          return [[LiteralMap]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitBinary, "parameters", {get: function() {
          return [[Binary]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitPrefixNot, "parameters", {get: function() {
          return [[PrefixNot]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitConditional, "parameters", {get: function() {
          return [[Conditional]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitPipe, "parameters", {get: function() {
          return [[Pipe]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype.visitKeyedAccess, "parameters", {get: function() {
          return [[KeyedAccess]];
        }});
      Object.defineProperty(_ConvertAstIntoProtoRecords.prototype._visitAll, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(_arrayFn, "parameters", {get: function() {
          return [[assert.type.number]];
        }});
      Object.defineProperty(_mapPrimitiveName, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(_operationToPrimitiveName, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_operationToFunction, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_interpolationFn, "parameters", {get: function() {
          return [[List]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/shadow_dom_strategy", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/collection", "angular2/src/facade/async", "angular2/src/dom/dom_adapter", "angular2/src/core/compiler/view", "angular2/src/core/compiler/shadow_dom_emulation/light_dom", "angular2/src/render/dom/shadow_dom/shadow_css", "angular2/src/render/dom/shadow_dom/style_inliner", "angular2/src/render/dom/shadow_dom/style_url_resolver", "angular2/src/core/compiler/directive_metadata", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/compile_control"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/shadow_dom_strategy";
  var Injectable,
      Type,
      isBlank,
      isPresent,
      int,
      StringWrapper,
      assertionsEnabled,
      List,
      ListWrapper,
      MapWrapper,
      Map,
      PromiseWrapper,
      DOM,
      viewModule,
      LightDom,
      ShadowCss,
      StyleInliner,
      StyleUrlResolver,
      DirectiveMetadata,
      NS,
      CompileElement,
      CompileControl,
      _EMPTY_STEP,
      ShadowDomStrategy,
      EmulatedUnscopedShadowDomStrategy,
      EmulatedScopedShadowDomStrategy,
      NativeShadowDomStrategy,
      _BaseEmulatedShadowDomStep,
      _EmptyCompileStep,
      _ShimShadowDomStep,
      _EmulatedUnscopedCssStep,
      _EmulatedScopedCssStep,
      _NativeCssStep,
      _componentUIDs,
      _nextComponentUID,
      _sharedStyleTexts,
      _lastInsertedStyleEl;
  function _emptyStep() {
    if (isBlank(_EMPTY_STEP)) {
      _EMPTY_STEP = new _EmptyCompileStep();
    }
    return _EMPTY_STEP;
  }
  function _moveViewNodesIntoParent(parent, view) {
    for (var i = 0; i < view.nodes.length; ++i) {
      DOM.appendChild(parent, view.nodes[i]);
    }
  }
  function _getComponentId(component) {
    var id = MapWrapper.get(_componentUIDs, component);
    if (isBlank(id)) {
      id = _nextComponentUID++;
      MapWrapper.set(_componentUIDs, component, id);
    }
    return id;
  }
  function _insertStyleElement(host, styleEl) {
    if (isBlank(_lastInsertedStyleEl)) {
      var firstChild = DOM.firstChild(host);
      if (isPresent(firstChild)) {
        DOM.insertBefore(firstChild, styleEl);
      } else {
        DOM.appendChild(host, styleEl);
      }
    } else {
      DOM.insertAfter(_lastInsertedStyleEl, styleEl);
    }
    _lastInsertedStyleEl = styleEl;
  }
  function _getHostAttribute(id) {
    return ("_nghost-" + id);
  }
  function _getContentAttribute(id) {
    return ("_ngcontent-" + id);
  }
  function _shimCssForComponent(cssText, component) {
    var id = _getComponentId(component);
    var shadowCss = new ShadowCss();
    return shadowCss.shimCssText(cssText, _getContentAttribute(id), _getHostAttribute(id));
  }
  function resetShadowDomCache() {
    MapWrapper.clear(_componentUIDs);
    _nextComponentUID = 0;
    MapWrapper.clear(_sharedStyleTexts);
    _lastInsertedStyleEl = null;
  }
  $__export("resetShadowDomCache", resetShadowDomCache);
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Type = $__m.Type;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      int = $__m.int;
      StringWrapper = $__m.StringWrapper;
      assertionsEnabled = $__m.assertionsEnabled;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      Map = $__m.Map;
    }, function($__m) {
      PromiseWrapper = $__m.PromiseWrapper;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      viewModule = $__m;
    }, function($__m) {
      LightDom = $__m.LightDom;
    }, function($__m) {
      ShadowCss = $__m.ShadowCss;
    }, function($__m) {
      StyleInliner = $__m.StyleInliner;
    }, function($__m) {
      StyleUrlResolver = $__m.StyleUrlResolver;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      NS = $__m;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      CompileControl = $__m.CompileControl;
    }],
    execute: function() {
      ShadowDomStrategy = $__export("ShadowDomStrategy", (function() {
        var ShadowDomStrategy = function ShadowDomStrategy() {
          ;
        };
        return ($traceurRuntime.createClass)(ShadowDomStrategy, {
          attachTemplate: function(el, view) {},
          constructLightDom: function(lightDomView, shadowDomView, el) {
            return null;
          },
          getStyleCompileStep: function(cmpMetadata, templateUrl) {
            return _emptyStep();
          },
          getTemplateCompileStep: function(cmpMetadata) {
            return _emptyStep();
          },
          shimAppElement: function(cmpMetadata, element) {}
        }, {});
      }()));
      Object.defineProperty(ShadowDomStrategy.prototype.attachTemplate, "parameters", {get: function() {
          return [[], [viewModule.View]];
        }});
      Object.defineProperty(ShadowDomStrategy.prototype.constructLightDom, "parameters", {get: function() {
          return [[viewModule.View], [viewModule.View], []];
        }});
      Object.defineProperty(ShadowDomStrategy.prototype.getStyleCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string]];
        }});
      Object.defineProperty(ShadowDomStrategy.prototype.getTemplateCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
      Object.defineProperty(ShadowDomStrategy.prototype.shimAppElement, "parameters", {get: function() {
          return [[DirectiveMetadata], []];
        }});
      EmulatedUnscopedShadowDomStrategy = $__export("EmulatedUnscopedShadowDomStrategy", (function($__super) {
        var EmulatedUnscopedShadowDomStrategy = function EmulatedUnscopedShadowDomStrategy(styleUrlResolver, styleHost) {
          $traceurRuntime.superConstructor(EmulatedUnscopedShadowDomStrategy).call(this);
          this._styleUrlResolver = styleUrlResolver;
          this._styleHost = styleHost;
        };
        return ($traceurRuntime.createClass)(EmulatedUnscopedShadowDomStrategy, {
          attachTemplate: function(el, view) {
            DOM.clearNodes(el);
            _moveViewNodesIntoParent(el, view);
          },
          constructLightDom: function(lightDomView, shadowDomView, el) {
            return new LightDom(lightDomView, shadowDomView, el);
          },
          getStyleCompileStep: function(cmpMetadata, templateUrl) {
            return new _EmulatedUnscopedCssStep(cmpMetadata, templateUrl, this._styleUrlResolver, this._styleHost);
          },
          getTemplateCompileStep: function(cmpMetadata) {
            return new _BaseEmulatedShadowDomStep();
          }
        }, {}, $__super);
      }(ShadowDomStrategy)));
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy, "parameters", {get: function() {
          return [[StyleUrlResolver], []];
        }});
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy.prototype.attachTemplate, "parameters", {get: function() {
          return [[], [viewModule.View]];
        }});
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy.prototype.constructLightDom, "parameters", {get: function() {
          return [[viewModule.View], [viewModule.View], []];
        }});
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy.prototype.getStyleCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string]];
        }});
      Object.defineProperty(EmulatedUnscopedShadowDomStrategy.prototype.getTemplateCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
      EmulatedScopedShadowDomStrategy = $__export("EmulatedScopedShadowDomStrategy", (function($__super) {
        var EmulatedScopedShadowDomStrategy = function EmulatedScopedShadowDomStrategy(styleInliner, styleUrlResolver, styleHost) {
          $traceurRuntime.superConstructor(EmulatedScopedShadowDomStrategy).call(this, styleUrlResolver, styleHost);
          this._styleInliner = styleInliner;
        };
        return ($traceurRuntime.createClass)(EmulatedScopedShadowDomStrategy, {
          getStyleCompileStep: function(cmpMetadata, templateUrl) {
            return new _EmulatedScopedCssStep(cmpMetadata, templateUrl, this._styleInliner, this._styleUrlResolver, this._styleHost);
          },
          getTemplateCompileStep: function(cmpMetadata) {
            return new _ShimShadowDomStep(cmpMetadata);
          },
          shimAppElement: function(cmpMetadata, element) {
            var cmpType = cmpMetadata.type;
            var hostAttribute = _getHostAttribute(_getComponentId(cmpType));
            DOM.setAttribute(element, hostAttribute, '');
          }
        }, {}, $__super);
      }(EmulatedUnscopedShadowDomStrategy)));
      Object.defineProperty(EmulatedScopedShadowDomStrategy, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(EmulatedScopedShadowDomStrategy, "parameters", {get: function() {
          return [[StyleInliner], [StyleUrlResolver], []];
        }});
      Object.defineProperty(EmulatedScopedShadowDomStrategy.prototype.getStyleCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string]];
        }});
      Object.defineProperty(EmulatedScopedShadowDomStrategy.prototype.getTemplateCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
      Object.defineProperty(EmulatedScopedShadowDomStrategy.prototype.shimAppElement, "parameters", {get: function() {
          return [[DirectiveMetadata], []];
        }});
      NativeShadowDomStrategy = $__export("NativeShadowDomStrategy", (function($__super) {
        var NativeShadowDomStrategy = function NativeShadowDomStrategy(styleUrlResolver) {
          $traceurRuntime.superConstructor(NativeShadowDomStrategy).call(this);
          this._styleUrlResolver = styleUrlResolver;
        };
        return ($traceurRuntime.createClass)(NativeShadowDomStrategy, {
          attachTemplate: function(el, view) {
            _moveViewNodesIntoParent(DOM.createShadowRoot(el), view);
          },
          getStyleCompileStep: function(cmpMetadata, templateUrl) {
            return new _NativeCssStep(templateUrl, this._styleUrlResolver);
          }
        }, {}, $__super);
      }(ShadowDomStrategy)));
      Object.defineProperty(NativeShadowDomStrategy, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(NativeShadowDomStrategy, "parameters", {get: function() {
          return [[StyleUrlResolver]];
        }});
      Object.defineProperty(NativeShadowDomStrategy.prototype.attachTemplate, "parameters", {get: function() {
          return [[], [viewModule.View]];
        }});
      Object.defineProperty(NativeShadowDomStrategy.prototype.getStyleCompileStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string]];
        }});
      _BaseEmulatedShadowDomStep = (function($__super) {
        var _BaseEmulatedShadowDomStep = function _BaseEmulatedShadowDomStep() {
          $traceurRuntime.superConstructor(_BaseEmulatedShadowDomStep).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(_BaseEmulatedShadowDomStep, {process: function(parent, current, control) {
            if (current.ignoreBindings) {
              return ;
            }
            var nodeName = DOM.nodeName(current.element);
            if (StringWrapper.equals(nodeName.toUpperCase(), 'CONTENT')) {
              var attrs = current.attrs();
              var selector = MapWrapper.get(attrs, 'select');
              current.contentTagSelector = isPresent(selector) ? selector : '';
              var contentStart = DOM.createScriptTag('type', 'ng/contentStart');
              if (assertionsEnabled()) {
                DOM.setAttribute(contentStart, 'select', current.contentTagSelector);
              }
              var contentEnd = DOM.createScriptTag('type', 'ng/contentEnd');
              DOM.insertBefore(current.element, contentStart);
              DOM.insertBefore(current.element, contentEnd);
              DOM.remove(current.element);
              current.element = contentStart;
            }
          }}, {}, $__super);
      }(NS.CompileStep));
      Object.defineProperty(_BaseEmulatedShadowDomStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _EmptyCompileStep = (function($__super) {
        var _EmptyCompileStep = function _EmptyCompileStep() {
          $traceurRuntime.superConstructor(_EmptyCompileStep).apply(this, arguments);
          ;
        };
        return ($traceurRuntime.createClass)(_EmptyCompileStep, {process: function(parent, current, control) {}}, {}, $__super);
      }(NS.CompileStep));
      Object.defineProperty(_EmptyCompileStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _ShimShadowDomStep = (function($__super) {
        var _ShimShadowDomStep = function _ShimShadowDomStep(cmpMetadata) {
          $traceurRuntime.superConstructor(_ShimShadowDomStep).call(this);
          var id = _getComponentId(cmpMetadata.type);
          this._contentAttribute = _getContentAttribute(id);
        };
        return ($traceurRuntime.createClass)(_ShimShadowDomStep, {process: function(parent, current, control) {
            $traceurRuntime.superGet(this, _ShimShadowDomStep.prototype, "process").call(this, parent, current, control);
            if (current.ignoreBindings) {
              return ;
            }
            DOM.setAttribute(current.element, this._contentAttribute, '');
            var host = current.componentDirective;
            if (isPresent(host)) {
              var hostId = _getComponentId(host.type);
              var hostAttribute = _getHostAttribute(hostId);
              DOM.setAttribute(current.element, hostAttribute, '');
            }
          }}, {}, $__super);
      }(_BaseEmulatedShadowDomStep));
      Object.defineProperty(_ShimShadowDomStep, "parameters", {get: function() {
          return [[DirectiveMetadata]];
        }});
      Object.defineProperty(_ShimShadowDomStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _EmulatedUnscopedCssStep = (function($__super) {
        var _EmulatedUnscopedCssStep = function _EmulatedUnscopedCssStep(cmpMetadata, templateUrl, styleUrlResolver, styleHost) {
          $traceurRuntime.superConstructor(_EmulatedUnscopedCssStep).call(this);
          this._templateUrl = templateUrl;
          this._styleUrlResolver = styleUrlResolver;
          this._styleHost = styleHost;
        };
        return ($traceurRuntime.createClass)(_EmulatedUnscopedCssStep, {process: function(parent, current, control) {
            var styleEl = current.element;
            var cssText = DOM.getText(styleEl);
            cssText = this._styleUrlResolver.resolveUrls(cssText, this._templateUrl);
            DOM.setText(styleEl, cssText);
            DOM.remove(styleEl);
            if (!MapWrapper.contains(_sharedStyleTexts, cssText)) {
              MapWrapper.set(_sharedStyleTexts, cssText, true);
              _insertStyleElement(this._styleHost, styleEl);
            }
          }}, {}, $__super);
      }(NS.CompileStep));
      Object.defineProperty(_EmulatedUnscopedCssStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string], [StyleUrlResolver], []];
        }});
      Object.defineProperty(_EmulatedUnscopedCssStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _EmulatedScopedCssStep = (function($__super) {
        var _EmulatedScopedCssStep = function _EmulatedScopedCssStep(cmpMetadata, templateUrl, styleInliner, styleUrlResolver, styleHost) {
          $traceurRuntime.superConstructor(_EmulatedScopedCssStep).call(this);
          this._templateUrl = templateUrl;
          this._component = cmpMetadata.type;
          this._styleInliner = styleInliner;
          this._styleUrlResolver = styleUrlResolver;
          this._styleHost = styleHost;
        };
        return ($traceurRuntime.createClass)(_EmulatedScopedCssStep, {process: function(parent, current, control) {
            var $__0 = this;
            var styleEl = current.element;
            var cssText = DOM.getText(styleEl);
            cssText = this._styleUrlResolver.resolveUrls(cssText, this._templateUrl);
            var css = this._styleInliner.inlineImports(cssText, this._templateUrl);
            if (PromiseWrapper.isPromise(css)) {
              DOM.setText(styleEl, '');
              ListWrapper.push(parent.inheritedProtoView.stylePromises, css);
              return css.then((function(css) {
                css = _shimCssForComponent(css, $__0._component);
                DOM.setText(styleEl, css);
              }));
            } else {
              css = _shimCssForComponent(css, this._component);
              DOM.setText(styleEl, css);
            }
            DOM.remove(styleEl);
            _insertStyleElement(this._styleHost, styleEl);
          }}, {}, $__super);
      }(NS.CompileStep));
      Object.defineProperty(_EmulatedScopedCssStep, "parameters", {get: function() {
          return [[DirectiveMetadata], [assert.type.string], [StyleInliner], [StyleUrlResolver], []];
        }});
      Object.defineProperty(_EmulatedScopedCssStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _NativeCssStep = (function($__super) {
        var _NativeCssStep = function _NativeCssStep(templateUrl, styleUrlResover) {
          $traceurRuntime.superConstructor(_NativeCssStep).call(this);
          this._styleUrlResolver = styleUrlResover;
          this._templateUrl = templateUrl;
        };
        return ($traceurRuntime.createClass)(_NativeCssStep, {process: function(parent, current, control) {
            var styleEl = current.element;
            var cssText = DOM.getText(styleEl);
            cssText = this._styleUrlResolver.resolveUrls(cssText, this._templateUrl);
            DOM.setText(styleEl, cssText);
          }}, {}, $__super);
      }(NS.CompileStep));
      Object.defineProperty(_NativeCssStep, "parameters", {get: function() {
          return [[assert.type.string], [StyleUrlResolver]];
        }});
      Object.defineProperty(_NativeCssStep.prototype.process, "parameters", {get: function() {
          return [[CompileElement], [CompileElement], [CompileControl]];
        }});
      _componentUIDs = MapWrapper.create();
      _nextComponentUID = 0;
      _sharedStyleTexts = MapWrapper.create();
      Object.defineProperty(_getComponentId, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(_getHostAttribute, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_getContentAttribute, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_shimCssForComponent, "parameters", {get: function() {
          return [[assert.type.string], [Type]];
        }});
    }
  };
});

System.register("angular2/src/di/injector", ["angular2/src/facade/collection", "angular2/src/di/binding", "angular2/src/di/exceptions", "angular2/src/facade/lang", "angular2/src/facade/async", "angular2/src/di/key"], function($__export) {
  "";
  var __moduleName = "angular2/src/di/injector";
  var Map,
      List,
      MapWrapper,
      ListWrapper,
      Binding,
      BindingBuilder,
      bind,
      ProviderError,
      NoProviderError,
      InvalidBindingError,
      AsyncBindingError,
      CyclicDependencyError,
      InstantiationError,
      FunctionWrapper,
      Type,
      isPresent,
      isBlank,
      Promise,
      PromiseWrapper,
      Key,
      _constructing,
      _notFound,
      _Waiting,
      Injector,
      _SyncInjectorStrategy,
      _AsyncInjectorStrategy;
  function _isWaiting(obj) {
    return obj instanceof _Waiting;
  }
  function _flattenBindings(bindings, res) {
    ListWrapper.forEach(bindings, function(b) {
      if (b instanceof Binding) {
        MapWrapper.set(res, b.key.id, b);
      } else if (b instanceof Type) {
        var s = bind(b).toClass(b);
        MapWrapper.set(res, s.key.id, s);
      } else if (b instanceof List) {
        _flattenBindings(b, res);
      } else if (b instanceof BindingBuilder) {
        throw new InvalidBindingError(b.token);
      } else {
        throw new InvalidBindingError(b);
      }
    });
    return res;
  }
  return {
    setters: [function($__m) {
      Map = $__m.Map;
      List = $__m.List;
      MapWrapper = $__m.MapWrapper;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      Binding = $__m.Binding;
      BindingBuilder = $__m.BindingBuilder;
      bind = $__m.bind;
    }, function($__m) {
      ProviderError = $__m.ProviderError;
      NoProviderError = $__m.NoProviderError;
      InvalidBindingError = $__m.InvalidBindingError;
      AsyncBindingError = $__m.AsyncBindingError;
      CyclicDependencyError = $__m.CyclicDependencyError;
      InstantiationError = $__m.InstantiationError;
    }, function($__m) {
      FunctionWrapper = $__m.FunctionWrapper;
      Type = $__m.Type;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
    }, function($__m) {
      Promise = $__m.Promise;
      PromiseWrapper = $__m.PromiseWrapper;
    }, function($__m) {
      Key = $__m.Key;
    }],
    execute: function() {
      _constructing = new Object();
      _notFound = new Object();
      _Waiting = (function() {
        var _Waiting = function _Waiting(promise) {
          this.promise = promise;
        };
        return ($traceurRuntime.createClass)(_Waiting, {}, {});
      }());
      Object.defineProperty(_Waiting, "parameters", {get: function() {
          return [[Promise]];
        }});
      Injector = $__export("Injector", (function() {
        var Injector = function Injector(bindings) {
          var $__3,
              $__4;
          var $__2 = arguments[1] !== (void 0) ? arguments[1] : {},
              parent = ($__3 = $__2.parent) === void 0 ? null : $__3,
              defaultBindings = ($__4 = $__2.defaultBindings) === void 0 ? false : $__4;
          var flatten = _flattenBindings(bindings, MapWrapper.create());
          this._bindings = this._createListOfBindings(flatten);
          this._instances = this._createInstances();
          this._parent = parent;
          this._defaultBindings = defaultBindings;
          this._asyncStrategy = new _AsyncInjectorStrategy(this);
          this._syncStrategy = new _SyncInjectorStrategy(this);
        };
        return ($traceurRuntime.createClass)(Injector, {
          get: function(token) {
            return this._getByKey(Key.get(token), false, false, false);
          },
          getOptional: function(token) {
            return this._getByKey(Key.get(token), false, false, true);
          },
          asyncGet: function(token) {
            return this._getByKey(Key.get(token), true, false, false);
          },
          createChild: function(bindings) {
            return new Injector(bindings, {parent: this});
          },
          _createListOfBindings: function(flattenBindings) {
            var bindings = ListWrapper.createFixedSize(Key.numberOfKeys + 1);
            MapWrapper.forEach(flattenBindings, (function(v, keyId) {
              return bindings[keyId] = v;
            }));
            return bindings;
          },
          _createInstances: function() {
            return ListWrapper.createFixedSize(Key.numberOfKeys + 1);
          },
          _getByKey: function(key, returnPromise, returnLazy, optional) {
            var $__0 = this;
            if (returnLazy) {
              return (function() {
                return $__0._getByKey(key, returnPromise, false, optional);
              });
            }
            var strategy = returnPromise ? this._asyncStrategy : this._syncStrategy;
            var instance = strategy.readFromCache(key);
            if (instance !== _notFound)
              return instance;
            instance = strategy.instantiate(key);
            if (instance !== _notFound)
              return instance;
            if (isPresent(this._parent)) {
              return this._parent._getByKey(key, returnPromise, returnLazy, optional);
            }
            if (optional) {
              return null;
            } else {
              throw new NoProviderError(key);
            }
          },
          _resolveDependencies: function(key, binding, forceAsync) {
            var $__0 = this;
            try {
              var getDependency = (function(d) {
                return $__0._getByKey(d.key, forceAsync || d.asPromise, d.lazy, d.optional);
              });
              return ListWrapper.map(binding.dependencies, getDependency);
            } catch (e) {
              this._clear(key);
              if (e instanceof ProviderError)
                e.addKey(key);
              throw e;
            }
          },
          _getInstance: function(key) {
            if (this._instances.length <= key.id)
              return null;
            return ListWrapper.get(this._instances, key.id);
          },
          _setInstance: function(key, obj) {
            ListWrapper.set(this._instances, key.id, obj);
          },
          _getBinding: function(key) {
            var binding = this._bindings.length <= key.id ? null : ListWrapper.get(this._bindings, key.id);
            if (isBlank(binding) && this._defaultBindings) {
              return bind(key.token).toClass(key.token);
            } else {
              return binding;
            }
          },
          _markAsConstructing: function(key) {
            this._setInstance(key, _constructing);
          },
          _clear: function(key) {
            this._setInstance(key, null);
          }
        }, {});
      }()));
      Object.defineProperty(Injector, "parameters", {get: function() {
          return [[List], []];
        }});
      Object.defineProperty(Injector.prototype.createChild, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(Injector.prototype._getByKey, "parameters", {get: function() {
          return [[Key], [assert.type.boolean], [assert.type.boolean], [assert.type.boolean]];
        }});
      Object.defineProperty(Injector.prototype._resolveDependencies, "parameters", {get: function() {
          return [[Key], [Binding], [assert.type.boolean]];
        }});
      Object.defineProperty(Injector.prototype._getInstance, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(Injector.prototype._setInstance, "parameters", {get: function() {
          return [[Key], []];
        }});
      Object.defineProperty(Injector.prototype._getBinding, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(Injector.prototype._markAsConstructing, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(Injector.prototype._clear, "parameters", {get: function() {
          return [[Key]];
        }});
      _SyncInjectorStrategy = (function() {
        var _SyncInjectorStrategy = function _SyncInjectorStrategy(injector) {
          this.injector = injector;
        };
        return ($traceurRuntime.createClass)(_SyncInjectorStrategy, {
          readFromCache: function(key) {
            if (key.token === Injector) {
              return this.injector;
            }
            var instance = this.injector._getInstance(key);
            if (instance === _constructing) {
              throw new CyclicDependencyError(key);
            } else if (isPresent(instance) && !_isWaiting(instance)) {
              return instance;
            } else {
              return _notFound;
            }
          },
          instantiate: function(key) {
            var binding = this.injector._getBinding(key);
            if (isBlank(binding))
              return _notFound;
            if (binding.providedAsPromise)
              throw new AsyncBindingError(key);
            this.injector._markAsConstructing(key);
            var deps = this.injector._resolveDependencies(key, binding, false);
            return this._createInstance(key, binding, deps);
          },
          _createInstance: function(key, binding, deps) {
            try {
              var instance = FunctionWrapper.apply(binding.factory, deps);
              this.injector._setInstance(key, instance);
              return instance;
            } catch (e) {
              this.injector._clear(key);
              throw new InstantiationError(e, key);
            }
          }
        }, {});
      }());
      Object.defineProperty(_SyncInjectorStrategy, "parameters", {get: function() {
          return [[Injector]];
        }});
      Object.defineProperty(_SyncInjectorStrategy.prototype.readFromCache, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(_SyncInjectorStrategy.prototype.instantiate, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(_SyncInjectorStrategy.prototype._createInstance, "parameters", {get: function() {
          return [[Key], [Binding], [List]];
        }});
      _AsyncInjectorStrategy = (function() {
        var _AsyncInjectorStrategy = function _AsyncInjectorStrategy(injector) {
          this.injector = injector;
        };
        return ($traceurRuntime.createClass)(_AsyncInjectorStrategy, {
          readFromCache: function(key) {
            if (key.token === Injector) {
              return PromiseWrapper.resolve(this.injector);
            }
            var instance = this.injector._getInstance(key);
            if (instance === _constructing) {
              throw new CyclicDependencyError(key);
            } else if (_isWaiting(instance)) {
              return instance.promise;
            } else if (isPresent(instance)) {
              return PromiseWrapper.resolve(instance);
            } else {
              return _notFound;
            }
          },
          instantiate: function(key) {
            var $__0 = this;
            var binding = this.injector._getBinding(key);
            if (isBlank(binding))
              return _notFound;
            this.injector._markAsConstructing(key);
            var deps = this.injector._resolveDependencies(key, binding, true);
            var depsPromise = PromiseWrapper.all(deps);
            var promise = PromiseWrapper.then(depsPromise, null, (function(e) {
              return $__0._errorHandler(key, e);
            })).then((function(deps) {
              return $__0._findOrCreate(key, binding, deps);
            })).then((function(instance) {
              return $__0._cacheInstance(key, instance);
            }));
            this.injector._setInstance(key, new _Waiting(promise));
            return promise;
          },
          _errorHandler: function(key, e) {
            if (e instanceof ProviderError)
              e.addKey(key);
            return PromiseWrapper.reject(e);
          },
          _findOrCreate: function(key, binding, deps) {
            try {
              var instance = this.injector._getInstance(key);
              if (!_isWaiting(instance))
                return instance;
              return FunctionWrapper.apply(binding.factory, deps);
            } catch (e) {
              this.injector._clear(key);
              throw new InstantiationError(e, key);
            }
          },
          _cacheInstance: function(key, instance) {
            this.injector._setInstance(key, instance);
            return instance;
          }
        }, {});
      }());
      Object.defineProperty(_AsyncInjectorStrategy, "parameters", {get: function() {
          return [[Injector]];
        }});
      Object.defineProperty(_AsyncInjectorStrategy.prototype.readFromCache, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(_AsyncInjectorStrategy.prototype.instantiate, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(_AsyncInjectorStrategy.prototype._errorHandler, "parameters", {get: function() {
          return [[Key], []];
        }});
      Object.defineProperty(_AsyncInjectorStrategy.prototype._findOrCreate, "parameters", {get: function() {
          return [[Key], [Binding], [List]];
        }});
      Object.defineProperty(_flattenBindings, "parameters", {get: function() {
          return [[List], [Map]];
        }});
    }
  };
});

System.register("angular2/src/core/compiler/private_component_location", ["angular2/src/core/annotations/annotations", "angular2/src/core/dom/element", "angular2/src/core/compiler/view", "angular2/src/core/compiler/element_injector", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/render/dom/events/event_manager", "angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/private_component_location";
  var Directive,
      NgElement,
      viewModule,
      eiModule,
      ShadowDomStrategy,
      EventManager,
      ListWrapper,
      Type,
      PrivateComponentLocation;
  return {
    setters: [function($__m) {
      Directive = $__m.Directive;
    }, function($__m) {
      NgElement = $__m.NgElement;
    }, function($__m) {
      viewModule = $__m;
    }, function($__m) {
      eiModule = $__m;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      EventManager = $__m.EventManager;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      Type = $__m.Type;
    }],
    execute: function() {
      PrivateComponentLocation = $__export("PrivateComponentLocation", (function() {
        var PrivateComponentLocation = function PrivateComponentLocation(elementInjector, elt, view) {
          this._elementInjector = elementInjector;
          this._elt = elt;
          this._view = view;
        };
        return ($traceurRuntime.createClass)(PrivateComponentLocation, {createComponent: function(type, annotation, componentProtoView, eventManager, shadowDomStrategy) {
            var context = this._elementInjector.createPrivateComponent(type, annotation);
            var view = componentProtoView.instantiate(this._elementInjector, eventManager);
            view.hydrate(this._elementInjector.getShadowDomAppInjector(), this._elementInjector, null, context, null);
            shadowDomStrategy.attachTemplate(this._elt.domElement, view);
            ListWrapper.push(this._view.componentChildViews, view);
            this._view.changeDetector.addChild(view.changeDetector);
          }}, {});
      }()));
      Object.defineProperty(PrivateComponentLocation, "parameters", {get: function() {
          return [[eiModule.ElementInjector], [NgElement], [viewModule.View]];
        }});
      Object.defineProperty(PrivateComponentLocation.prototype.createComponent, "parameters", {get: function() {
          return [[Type], [Directive], [viewModule.ProtoView], [EventManager], [ShadowDomStrategy]];
        }});
    }
  };
});

System.register("angular2/di", ["angular2/src/di/annotations", "angular2/src/di/injector", "angular2/src/di/binding", "angular2/src/di/key", "angular2/src/di/exceptions", "angular2/src/di/opaque_token"], function($__export) {
  "";
  var __moduleName = "angular2/di";
  return {
    setters: [function($__m) {
      $__export("Inject", $__m.Inject);
      $__export("InjectPromise", $__m.InjectPromise);
      $__export("InjectLazy", $__m.InjectLazy);
      $__export("Injectable", $__m.Injectable);
      $__export("Optional", $__m.Optional);
      $__export("DependencyAnnotation", $__m.DependencyAnnotation);
    }, function($__m) {
      $__export("Injector", $__m.Injector);
    }, function($__m) {
      $__export("Binding", $__m.Binding);
      $__export("Dependency", $__m.Dependency);
      $__export("bind", $__m.bind);
    }, function($__m) {
      $__export("Key", $__m.Key);
      $__export("KeyRegistry", $__m.KeyRegistry);
    }, function($__m) {
      $__export("KeyMetadataError", $__m.KeyMetadataError);
      $__export("NoProviderError", $__m.NoProviderError);
      $__export("ProviderError", $__m.ProviderError);
      $__export("AsyncBindingError", $__m.AsyncBindingError);
      $__export("CyclicDependencyError", $__m.CyclicDependencyError);
      $__export("InstantiationError", $__m.InstantiationError);
      $__export("InvalidBindingError", $__m.InvalidBindingError);
      $__export("NoAnnotationError", $__m.NoAnnotationError);
    }, function($__m) {
      $__export("OpaqueToken", $__m.OpaqueToken);
    }],
    execute: function() {}
  };
});

System.register("angular2/src/core/compiler/element_injector", ["angular2/src/facade/lang", "angular2/src/facade/math", "angular2/src/facade/collection", "angular2/di", "angular2/src/core/annotations/visibility", "angular2/src/core/annotations/di", "angular2/src/core/compiler/view", "angular2/src/core/compiler/view_container", "angular2/src/core/dom/element", "angular2/src/core/annotations/annotations", "angular2/change_detection", "angular2/src/core/compiler/private_component_location", "angular2/src/render/dom/compiler/property_setter_factory"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/element_injector";
  var isPresent,
      isBlank,
      Type,
      int,
      BaseException,
      Math,
      List,
      ListWrapper,
      MapWrapper,
      Injector,
      Key,
      Dependency,
      bind,
      Binding,
      NoProviderError,
      ProviderError,
      CyclicDependencyError,
      Parent,
      Ancestor,
      EventEmitter,
      PropertySetter,
      Attribute,
      viewModule,
      ViewContainer,
      NgElement,
      Directive,
      onChange,
      onDestroy,
      onAllChangesDone,
      BindingPropagationConfig,
      pclModule,
      setterFactory,
      _MAX_DIRECTIVE_CONSTRUCTION_COUNTER,
      MAX_DEPTH,
      _undefined,
      _staticKeys,
      StaticKeys,
      TreeNode,
      DirectiveDependency,
      DirectiveBinding,
      PreBuiltObjects,
      ProtoElementInjector,
      ElementInjector,
      OutOfBoundsAccess;
  return {
    setters: [function($__m) {
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      Type = $__m.Type;
      int = $__m.int;
      BaseException = $__m.BaseException;
    }, function($__m) {
      Math = $__m.Math;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      Injector = $__m.Injector;
      Key = $__m.Key;
      Dependency = $__m.Dependency;
      bind = $__m.bind;
      Binding = $__m.Binding;
      NoProviderError = $__m.NoProviderError;
      ProviderError = $__m.ProviderError;
      CyclicDependencyError = $__m.CyclicDependencyError;
    }, function($__m) {
      Parent = $__m.Parent;
      Ancestor = $__m.Ancestor;
    }, function($__m) {
      EventEmitter = $__m.EventEmitter;
      PropertySetter = $__m.PropertySetter;
      Attribute = $__m.Attribute;
    }, function($__m) {
      viewModule = $__m;
    }, function($__m) {
      ViewContainer = $__m.ViewContainer;
    }, function($__m) {
      NgElement = $__m.NgElement;
    }, function($__m) {
      Directive = $__m.Directive;
      onChange = $__m.onChange;
      onDestroy = $__m.onDestroy;
      onAllChangesDone = $__m.onAllChangesDone;
    }, function($__m) {
      BindingPropagationConfig = $__m.BindingPropagationConfig;
    }, function($__m) {
      pclModule = $__m;
    }, function($__m) {
      setterFactory = $__m.setterFactory;
    }],
    execute: function() {
      _MAX_DIRECTIVE_CONSTRUCTION_COUNTER = 10;
      MAX_DEPTH = Math.pow(2, 30) - 1;
      _undefined = new Object();
      StaticKeys = (function() {
        var StaticKeys = function StaticKeys() {
          this.viewId = Key.get(viewModule.View).id;
          this.ngElementId = Key.get(NgElement).id;
          this.viewContainerId = Key.get(ViewContainer).id;
          this.bindingPropagationConfigId = Key.get(BindingPropagationConfig).id;
          this.privateComponentLocationId = Key.get(pclModule.PrivateComponentLocation).id;
        };
        return ($traceurRuntime.createClass)(StaticKeys, {}, {instance: function() {
            if (isBlank(_staticKeys))
              _staticKeys = new StaticKeys();
            return _staticKeys;
          }});
      }());
      TreeNode = (function() {
        var TreeNode = function TreeNode(parent) {
          this._parent = parent;
          this._head = null;
          this._tail = null;
          this._next = null;
          if (isPresent(parent))
            parent._addChild(this);
        };
        return ($traceurRuntime.createClass)(TreeNode, {
          _addChild: function(child) {
            if (isPresent(this._tail)) {
              this._tail._next = child;
              this._tail = child;
            } else {
              this._tail = this._head = child;
            }
          },
          get parent() {
            return this._parent;
          },
          set parent(node) {
            this._parent = node;
          },
          get children() {
            var res = [];
            var child = this._head;
            while (child != null) {
              ListWrapper.push(res, child);
              child = child._next;
            }
            return res;
          }
        }, {});
      }());
      Object.defineProperty(TreeNode, "parameters", {get: function() {
          return [[TreeNode]];
        }});
      Object.defineProperty(TreeNode.prototype._addChild, "parameters", {get: function() {
          return [[TreeNode]];
        }});
      Object.defineProperty(Object.getOwnPropertyDescriptor(TreeNode.prototype, "parent").set, "parameters", {get: function() {
          return [[TreeNode]];
        }});
      DirectiveDependency = $__export("DirectiveDependency", (function($__super) {
        var DirectiveDependency = function DirectiveDependency(key, asPromise, lazy, optional, properties, depth, eventEmitterName, propSetterName, attributeName) {
          $traceurRuntime.superConstructor(DirectiveDependency).call(this, key, asPromise, lazy, optional, properties);
          this.depth = depth;
          this.eventEmitterName = eventEmitterName;
          this.propSetterName = propSetterName;
          this.attributeName = attributeName;
        };
        return ($traceurRuntime.createClass)(DirectiveDependency, {}, {createFrom: function(d) {
            var depth = 0;
            var eventName = null;
            var propName = null;
            var attributeName = null;
            var properties = d.properties;
            for (var i = 0; i < properties.length; i++) {
              var property = properties[i];
              if (property instanceof Parent) {
                depth = 1;
              } else if (property instanceof Ancestor) {
                depth = MAX_DEPTH;
              } else if (property instanceof EventEmitter) {
                eventName = property.eventName;
              } else if (property instanceof PropertySetter) {
                propName = property.propName;
              } else if (property instanceof Attribute) {
                attributeName = property.attributeName;
              }
            }
            return new DirectiveDependency(d.key, d.asPromise, d.lazy, d.optional, d.properties, depth, eventName, propName, attributeName);
          }}, $__super);
      }(Dependency)));
      Object.defineProperty(DirectiveDependency, "parameters", {get: function() {
          return [[Key], [assert.type.boolean], [assert.type.boolean], [assert.type.boolean], [List], [int], [assert.type.string], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(DirectiveDependency.createFrom, "parameters", {get: function() {
          return [[Dependency]];
        }});
      DirectiveBinding = $__export("DirectiveBinding", (function($__super) {
        var DirectiveBinding = function DirectiveBinding(key, factory, dependencies, providedAsPromise, annotation) {
          $traceurRuntime.superConstructor(DirectiveBinding).call(this, key, factory, dependencies, providedAsPromise);
          this.callOnDestroy = isPresent(annotation) && annotation.hasLifecycleHook(onDestroy);
          this.callOnChange = isPresent(annotation) && annotation.hasLifecycleHook(onChange);
          this.callOnAllChangesDone = isPresent(annotation) && annotation.hasLifecycleHook(onAllChangesDone);
        };
        return ($traceurRuntime.createClass)(DirectiveBinding, {}, {
          createFromBinding: function(b, annotation) {
            var deps = ListWrapper.map(b.dependencies, DirectiveDependency.createFrom);
            return new DirectiveBinding(b.key, b.factory, deps, b.providedAsPromise, annotation);
          },
          createFromType: function(type, annotation) {
            var binding = bind(type).toClass(type);
            return DirectiveBinding.createFromBinding(binding, annotation);
          },
          _hasEventEmitter: function(eventName, binding) {
            return ListWrapper.any(binding.dependencies, (function(d) {
              return (d.eventEmitterName == eventName);
            }));
          }
        }, $__super);
      }(Binding)));
      Object.defineProperty(DirectiveBinding, "parameters", {get: function() {
          return [[Key], [Function], [List], [assert.type.boolean], [Directive]];
        }});
      Object.defineProperty(DirectiveBinding.createFromBinding, "parameters", {get: function() {
          return [[Binding], [Directive]];
        }});
      Object.defineProperty(DirectiveBinding.createFromType, "parameters", {get: function() {
          return [[Type], [Directive]];
        }});
      Object.defineProperty(DirectiveBinding._hasEventEmitter, "parameters", {get: function() {
          return [[assert.type.string], [DirectiveBinding]];
        }});
      PreBuiltObjects = $__export("PreBuiltObjects", (function() {
        var PreBuiltObjects = function PreBuiltObjects(view, element, viewContainer, bindingPropagationConfig) {
          this.view = view;
          this.element = element;
          this.viewContainer = viewContainer;
          this.bindingPropagationConfig = bindingPropagationConfig;
        };
        return ($traceurRuntime.createClass)(PreBuiltObjects, {}, {});
      }()));
      Object.defineProperty(PreBuiltObjects, "parameters", {get: function() {
          return [[], [NgElement], [ViewContainer], [BindingPropagationConfig]];
        }});
      ProtoElementInjector = $__export("ProtoElementInjector", (function() {
        var ProtoElementInjector = function ProtoElementInjector(parent, index, bindings) {
          var firstBindingIsComponent = arguments[3] !== (void 0) ? arguments[3] : false;
          var distanceToParent = arguments[4] !== (void 0) ? arguments[4] : 0;
          this.parent = parent;
          this.index = index;
          this.distanceToParent = distanceToParent;
          this.exportComponent = false;
          this.exportElement = false;
          this._binding0IsComponent = firstBindingIsComponent;
          this._binding0 = null;
          this._keyId0 = null;
          this._binding1 = null;
          this._keyId1 = null;
          this._binding2 = null;
          this._keyId2 = null;
          this._binding3 = null;
          this._keyId3 = null;
          this._binding4 = null;
          this._keyId4 = null;
          this._binding5 = null;
          this._keyId5 = null;
          this._binding6 = null;
          this._keyId6 = null;
          this._binding7 = null;
          this._keyId7 = null;
          this._binding8 = null;
          this._keyId8 = null;
          this._binding9 = null;
          this._keyId9 = null;
          this.numberOfDirectives = bindings.length;
          var length = bindings.length;
          if (length > 0) {
            this._binding0 = this._createBinding(bindings[0]);
            this._keyId0 = this._binding0.key.id;
          }
          if (length > 1) {
            this._binding1 = this._createBinding(bindings[1]);
            this._keyId1 = this._binding1.key.id;
          }
          if (length > 2) {
            this._binding2 = this._createBinding(bindings[2]);
            this._keyId2 = this._binding2.key.id;
          }
          if (length > 3) {
            this._binding3 = this._createBinding(bindings[3]);
            this._keyId3 = this._binding3.key.id;
          }
          if (length > 4) {
            this._binding4 = this._createBinding(bindings[4]);
            this._keyId4 = this._binding4.key.id;
          }
          if (length > 5) {
            this._binding5 = this._createBinding(bindings[5]);
            this._keyId5 = this._binding5.key.id;
          }
          if (length > 6) {
            this._binding6 = this._createBinding(bindings[6]);
            this._keyId6 = this._binding6.key.id;
          }
          if (length > 7) {
            this._binding7 = this._createBinding(bindings[7]);
            this._keyId7 = this._binding7.key.id;
          }
          if (length > 8) {
            this._binding8 = this._createBinding(bindings[8]);
            this._keyId8 = this._binding8.key.id;
          }
          if (length > 9) {
            this._binding9 = this._createBinding(bindings[9]);
            this._keyId9 = this._binding9.key.id;
          }
          if (length > 10) {
            throw 'Maximum number of directives per element has been reached.';
          }
        };
        return ($traceurRuntime.createClass)(ProtoElementInjector, {
          instantiate: function(parent, host) {
            return new ElementInjector(this, parent, host);
          },
          directParent: function() {
            return this.distanceToParent < 2 ? this.parent : null;
          },
          _createBinding: function(bindingOrType) {
            if (bindingOrType instanceof DirectiveBinding) {
              return bindingOrType;
            } else {
              var b = bind(bindingOrType).toClass(bindingOrType);
              return DirectiveBinding.createFromBinding(b, null);
            }
          },
          get hasBindings() {
            return isPresent(this._binding0);
          },
          getDirectiveBindingAtIndex: function(index) {
            if (index == 0)
              return this._binding0;
            if (index == 1)
              return this._binding1;
            if (index == 2)
              return this._binding2;
            if (index == 3)
              return this._binding3;
            if (index == 4)
              return this._binding4;
            if (index == 5)
              return this._binding5;
            if (index == 6)
              return this._binding6;
            if (index == 7)
              return this._binding7;
            if (index == 8)
              return this._binding8;
            if (index == 9)
              return this._binding9;
            throw new OutOfBoundsAccess(index);
          },
          hasEventEmitter: function(eventName) {
            var p = this;
            if (isPresent(p._binding0) && DirectiveBinding._hasEventEmitter(eventName, p._binding0))
              return true;
            if (isPresent(p._binding1) && DirectiveBinding._hasEventEmitter(eventName, p._binding1))
              return true;
            if (isPresent(p._binding2) && DirectiveBinding._hasEventEmitter(eventName, p._binding2))
              return true;
            if (isPresent(p._binding3) && DirectiveBinding._hasEventEmitter(eventName, p._binding3))
              return true;
            if (isPresent(p._binding4) && DirectiveBinding._hasEventEmitter(eventName, p._binding4))
              return true;
            if (isPresent(p._binding5) && DirectiveBinding._hasEventEmitter(eventName, p._binding5))
              return true;
            if (isPresent(p._binding6) && DirectiveBinding._hasEventEmitter(eventName, p._binding6))
              return true;
            if (isPresent(p._binding7) && DirectiveBinding._hasEventEmitter(eventName, p._binding7))
              return true;
            if (isPresent(p._binding8) && DirectiveBinding._hasEventEmitter(eventName, p._binding8))
              return true;
            if (isPresent(p._binding9) && DirectiveBinding._hasEventEmitter(eventName, p._binding9))
              return true;
            return false;
          }
        }, {});
      }()));
      Object.defineProperty(ProtoElementInjector, "parameters", {get: function() {
          return [[ProtoElementInjector], [int], [List], [assert.type.boolean], [assert.type.number]];
        }});
      Object.defineProperty(ProtoElementInjector.prototype.instantiate, "parameters", {get: function() {
          return [[ElementInjector], [ElementInjector]];
        }});
      Object.defineProperty(ProtoElementInjector.prototype.getDirectiveBindingAtIndex, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ProtoElementInjector.prototype.hasEventEmitter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      ElementInjector = $__export("ElementInjector", (function($__super) {
        var ElementInjector = function ElementInjector(proto, parent, host) {
          $traceurRuntime.superConstructor(ElementInjector).call(this, parent);
          if (isPresent(parent) && isPresent(host)) {
            throw new BaseException('Only either parent or host is allowed');
          }
          this._host = null;
          if (isPresent(parent)) {
            this._host = parent._host;
          } else {
            this._host = host;
          }
          this._proto = proto;
          this._preBuiltObjects = null;
          this._lightDomAppInjector = null;
          this._shadowDomAppInjector = null;
          this._obj0 = null;
          this._obj1 = null;
          this._obj2 = null;
          this._obj3 = null;
          this._obj4 = null;
          this._obj5 = null;
          this._obj6 = null;
          this._obj7 = null;
          this._obj8 = null;
          this._obj9 = null;
          this._constructionCounter = 0;
        };
        return ($traceurRuntime.createClass)(ElementInjector, {
          clearDirectives: function() {
            this._preBuiltObjects = null;
            this._lightDomAppInjector = null;
            this._shadowDomAppInjector = null;
            var p = this._proto;
            if (isPresent(p._binding0) && p._binding0.callOnDestroy) {
              this._obj0.onDestroy();
            }
            if (isPresent(p._binding1) && p._binding1.callOnDestroy) {
              this._obj1.onDestroy();
            }
            if (isPresent(p._binding2) && p._binding2.callOnDestroy) {
              this._obj2.onDestroy();
            }
            if (isPresent(p._binding3) && p._binding3.callOnDestroy) {
              this._obj3.onDestroy();
            }
            if (isPresent(p._binding4) && p._binding4.callOnDestroy) {
              this._obj4.onDestroy();
            }
            if (isPresent(p._binding5) && p._binding5.callOnDestroy) {
              this._obj5.onDestroy();
            }
            if (isPresent(p._binding6) && p._binding6.callOnDestroy) {
              this._obj6.onDestroy();
            }
            if (isPresent(p._binding7) && p._binding7.callOnDestroy) {
              this._obj7.onDestroy();
            }
            if (isPresent(p._binding8) && p._binding8.callOnDestroy) {
              this._obj8.onDestroy();
            }
            if (isPresent(p._binding9) && p._binding9.callOnDestroy) {
              this._obj9.onDestroy();
            }
            if (isPresent(this._privateComponentBinding) && this._privateComponentBinding.callOnDestroy) {
              this._privateComponent.onDestroy();
            }
            this._obj0 = null;
            this._obj1 = null;
            this._obj2 = null;
            this._obj3 = null;
            this._obj4 = null;
            this._obj5 = null;
            this._obj6 = null;
            this._obj7 = null;
            this._obj8 = null;
            this._obj9 = null;
            this._privateComponent = null;
            this._constructionCounter = 0;
          },
          instantiateDirectives: function(lightDomAppInjector, shadowDomAppInjector, preBuiltObjects) {
            this._checkShadowDomAppInjector(shadowDomAppInjector);
            this._preBuiltObjects = preBuiltObjects;
            this._lightDomAppInjector = lightDomAppInjector;
            this._shadowDomAppInjector = shadowDomAppInjector;
            var p = this._proto;
            if (isPresent(p._keyId0))
              this._getDirectiveByKeyId(p._keyId0);
            if (isPresent(p._keyId1))
              this._getDirectiveByKeyId(p._keyId1);
            if (isPresent(p._keyId2))
              this._getDirectiveByKeyId(p._keyId2);
            if (isPresent(p._keyId3))
              this._getDirectiveByKeyId(p._keyId3);
            if (isPresent(p._keyId4))
              this._getDirectiveByKeyId(p._keyId4);
            if (isPresent(p._keyId5))
              this._getDirectiveByKeyId(p._keyId5);
            if (isPresent(p._keyId6))
              this._getDirectiveByKeyId(p._keyId6);
            if (isPresent(p._keyId7))
              this._getDirectiveByKeyId(p._keyId7);
            if (isPresent(p._keyId8))
              this._getDirectiveByKeyId(p._keyId8);
            if (isPresent(p._keyId9))
              this._getDirectiveByKeyId(p._keyId9);
            if (isPresent(this._privateComponentBinding)) {
              this._privateComponent = this._new(this._privateComponentBinding);
            }
          },
          createPrivateComponent: function(componentType, annotation) {
            this._privateComponentBinding = DirectiveBinding.createFromType(componentType, annotation);
            this._privateComponent = this._new(this._privateComponentBinding);
            return this._privateComponent;
          },
          _checkShadowDomAppInjector: function(shadowDomAppInjector) {
            if (this._proto._binding0IsComponent && isBlank(shadowDomAppInjector)) {
              throw new BaseException('A shadowDomAppInjector is required as this ElementInjector contains a component');
            } else if (!this._proto._binding0IsComponent && isPresent(shadowDomAppInjector)) {
              throw new BaseException('No shadowDomAppInjector allowed as there is not component stored in this ElementInjector');
            }
          },
          get: function(token) {
            return this._getByKey(Key.get(token), 0, false, null);
          },
          hasDirective: function(type) {
            return this._getDirectiveByKeyId(Key.get(type).id) !== _undefined;
          },
          hasPreBuiltObject: function(type) {
            var pb = this._getPreBuiltObjectByKeyId(Key.get(type).id);
            return pb !== _undefined && isPresent(pb);
          },
          forElement: function(el) {
            return this._preBuiltObjects.element.domElement === el;
          },
          getNgElement: function() {
            return this._preBuiltObjects.element;
          },
          getComponent: function() {
            if (this._proto._binding0IsComponent) {
              return this._obj0;
            } else {
              throw new BaseException('There is not component stored in this ElementInjector');
            }
          },
          getPrivateComponent: function() {
            return this._privateComponent;
          },
          getShadowDomAppInjector: function() {
            return this._shadowDomAppInjector;
          },
          directParent: function() {
            return this._proto.distanceToParent < 2 ? this.parent : null;
          },
          _isComponentKey: function(key) {
            return this._proto._binding0IsComponent && key.id === this._proto._keyId0;
          },
          _isPrivateComponentKey: function(key) {
            return isPresent(this._privateComponentBinding) && key.id === this._privateComponentBinding.key.id;
          },
          _new: function(binding) {
            if (this._constructionCounter++ > _MAX_DIRECTIVE_CONSTRUCTION_COUNTER) {
              throw new CyclicDependencyError(binding.key);
            }
            var factory = binding.factory;
            var deps = binding.dependencies;
            var length = deps.length;
            var d0,
                d1,
                d2,
                d3,
                d4,
                d5,
                d6,
                d7,
                d8,
                d9;
            try {
              d0 = length > 0 ? this._getByDependency(deps[0], binding.key) : null;
              d1 = length > 1 ? this._getByDependency(deps[1], binding.key) : null;
              d2 = length > 2 ? this._getByDependency(deps[2], binding.key) : null;
              d3 = length > 3 ? this._getByDependency(deps[3], binding.key) : null;
              d4 = length > 4 ? this._getByDependency(deps[4], binding.key) : null;
              d5 = length > 5 ? this._getByDependency(deps[5], binding.key) : null;
              d6 = length > 6 ? this._getByDependency(deps[6], binding.key) : null;
              d7 = length > 7 ? this._getByDependency(deps[7], binding.key) : null;
              d8 = length > 8 ? this._getByDependency(deps[8], binding.key) : null;
              d9 = length > 9 ? this._getByDependency(deps[9], binding.key) : null;
            } catch (e) {
              if (e instanceof ProviderError)
                e.addKey(binding.key);
              throw e;
            }
            var obj;
            switch (length) {
              case 0:
                obj = factory();
                break;
              case 1:
                obj = factory(d0);
                break;
              case 2:
                obj = factory(d0, d1);
                break;
              case 3:
                obj = factory(d0, d1, d2);
                break;
              case 4:
                obj = factory(d0, d1, d2, d3);
                break;
              case 5:
                obj = factory(d0, d1, d2, d3, d4);
                break;
              case 6:
                obj = factory(d0, d1, d2, d3, d4, d5);
                break;
              case 7:
                obj = factory(d0, d1, d2, d3, d4, d5, d6);
                break;
              case 8:
                obj = factory(d0, d1, d2, d3, d4, d5, d6, d7);
                break;
              case 9:
                obj = factory(d0, d1, d2, d3, d4, d5, d6, d7, d8);
                break;
              case 10:
                obj = factory(d0, d1, d2, d3, d4, d5, d6, d7, d8, d9);
                break;
              default:
                throw ("Directive " + binding.key.token + " can only have up to 10 dependencies.");
            }
            return obj;
          },
          _getByDependency: function(dep, requestor) {
            if (isPresent(dep.eventEmitterName))
              return this._buildEventEmitter(dep);
            if (isPresent(dep.propSetterName))
              return this._buildPropSetter(dep);
            if (isPresent(dep.attributeName))
              return this._buildAttribute(dep);
            return this._getByKey(dep.key, dep.depth, dep.optional, requestor);
          },
          _buildEventEmitter: function(dep) {
            var $__0 = this;
            var view = this._getPreBuiltObjectByKeyId(StaticKeys.instance().viewId);
            return (function(event) {
              view.triggerEventHandlers(dep.eventEmitterName, event, $__0._proto.index);
            });
          },
          _buildPropSetter: function(dep) {
            var ngElement = this._getPreBuiltObjectByKeyId(StaticKeys.instance().ngElementId);
            var domElement = ngElement.domElement;
            var setter = setterFactory(dep.propSetterName);
            return function(v) {
              setter(domElement, v);
            };
          },
          _buildAttribute: function(dep) {
            var attributes = this._proto.attributes;
            if (isPresent(attributes) && MapWrapper.contains(attributes, dep.attributeName)) {
              return MapWrapper.get(attributes, dep.attributeName);
            } else {
              return null;
            }
          },
          _getByKey: function(key, depth, optional, requestor) {
            var ei = this;
            if (!this._shouldIncludeSelf(depth)) {
              depth -= ei._proto.distanceToParent;
              ei = ei._parent;
            }
            while (ei != null && depth >= 0) {
              var preBuiltObj = ei._getPreBuiltObjectByKeyId(key.id);
              if (preBuiltObj !== _undefined)
                return preBuiltObj;
              var dir = ei._getDirectiveByKeyId(key.id);
              if (dir !== _undefined)
                return dir;
              depth -= ei._proto.distanceToParent;
              ei = ei._parent;
            }
            if (isPresent(this._host) && this._host._isComponentKey(key)) {
              return this._host.getComponent();
            } else if (isPresent(this._host) && this._host._isPrivateComponentKey(key)) {
              return this._host.getPrivateComponent();
            } else if (optional) {
              return this._appInjector(requestor).getOptional(key);
            } else {
              return this._appInjector(requestor).get(key);
            }
          },
          _appInjector: function(requestor) {
            if (isPresent(requestor) && this._isComponentKey(requestor)) {
              return this._shadowDomAppInjector;
            } else {
              return this._lightDomAppInjector;
            }
          },
          _shouldIncludeSelf: function(depth) {
            return depth === 0;
          },
          _getPreBuiltObjectByKeyId: function(keyId) {
            var staticKeys = StaticKeys.instance();
            if (keyId === staticKeys.viewId)
              return this._preBuiltObjects.view;
            if (keyId === staticKeys.ngElementId)
              return this._preBuiltObjects.element;
            if (keyId === staticKeys.viewContainerId)
              return this._preBuiltObjects.viewContainer;
            if (keyId === staticKeys.bindingPropagationConfigId)
              return this._preBuiltObjects.bindingPropagationConfig;
            if (keyId === staticKeys.privateComponentLocationId) {
              return new pclModule.PrivateComponentLocation(this, this._preBuiltObjects.element, this._preBuiltObjects.view);
            }
            return _undefined;
          },
          _getDirectiveByKeyId: function(keyId) {
            var p = this._proto;
            if (p._keyId0 === keyId) {
              if (isBlank(this._obj0)) {
                this._obj0 = this._new(p._binding0);
              }
              return this._obj0;
            }
            if (p._keyId1 === keyId) {
              if (isBlank(this._obj1)) {
                this._obj1 = this._new(p._binding1);
              }
              return this._obj1;
            }
            if (p._keyId2 === keyId) {
              if (isBlank(this._obj2)) {
                this._obj2 = this._new(p._binding2);
              }
              return this._obj2;
            }
            if (p._keyId3 === keyId) {
              if (isBlank(this._obj3)) {
                this._obj3 = this._new(p._binding3);
              }
              return this._obj3;
            }
            if (p._keyId4 === keyId) {
              if (isBlank(this._obj4)) {
                this._obj4 = this._new(p._binding4);
              }
              return this._obj4;
            }
            if (p._keyId5 === keyId) {
              if (isBlank(this._obj5)) {
                this._obj5 = this._new(p._binding5);
              }
              return this._obj5;
            }
            if (p._keyId6 === keyId) {
              if (isBlank(this._obj6)) {
                this._obj6 = this._new(p._binding6);
              }
              return this._obj6;
            }
            if (p._keyId7 === keyId) {
              if (isBlank(this._obj7)) {
                this._obj7 = this._new(p._binding7);
              }
              return this._obj7;
            }
            if (p._keyId8 === keyId) {
              if (isBlank(this._obj8)) {
                this._obj8 = this._new(p._binding8);
              }
              return this._obj8;
            }
            if (p._keyId9 === keyId) {
              if (isBlank(this._obj9)) {
                this._obj9 = this._new(p._binding9);
              }
              return this._obj9;
            }
            return _undefined;
          },
          getDirectiveAtIndex: function(index) {
            if (index == 0)
              return this._obj0;
            if (index == 1)
              return this._obj1;
            if (index == 2)
              return this._obj2;
            if (index == 3)
              return this._obj3;
            if (index == 4)
              return this._obj4;
            if (index == 5)
              return this._obj5;
            if (index == 6)
              return this._obj6;
            if (index == 7)
              return this._obj7;
            if (index == 8)
              return this._obj8;
            if (index == 9)
              return this._obj9;
            throw new OutOfBoundsAccess(index);
          },
          getDirectiveBindingAtIndex: function(index) {
            return this._proto.getDirectiveBindingAtIndex(index);
          },
          hasInstances: function() {
            return this._constructionCounter > 0;
          },
          hasEventEmitter: function(eventName) {
            return this._proto.hasEventEmitter(eventName);
          },
          isExportingComponent: function() {
            return this._proto.exportComponent;
          },
          isExportingElement: function() {
            return this._proto.exportElement;
          },
          getExportImplicitName: function() {
            return this._proto.exportImplicitName;
          }
        }, {}, $__super);
      }(TreeNode)));
      Object.defineProperty(ElementInjector, "parameters", {get: function() {
          return [[ProtoElementInjector], [ElementInjector], [ElementInjector]];
        }});
      Object.defineProperty(ElementInjector.prototype.instantiateDirectives, "parameters", {get: function() {
          return [[Injector], [Injector], [PreBuiltObjects]];
        }});
      Object.defineProperty(ElementInjector.prototype.createPrivateComponent, "parameters", {get: function() {
          return [[Type], [Directive]];
        }});
      Object.defineProperty(ElementInjector.prototype._checkShadowDomAppInjector, "parameters", {get: function() {
          return [[Injector]];
        }});
      Object.defineProperty(ElementInjector.prototype.hasDirective, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(ElementInjector.prototype.hasPreBuiltObject, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(ElementInjector.prototype._isComponentKey, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(ElementInjector.prototype._isPrivateComponentKey, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(ElementInjector.prototype._new, "parameters", {get: function() {
          return [[Binding]];
        }});
      Object.defineProperty(ElementInjector.prototype._getByDependency, "parameters", {get: function() {
          return [[DirectiveDependency], [Key]];
        }});
      Object.defineProperty(ElementInjector.prototype._getByKey, "parameters", {get: function() {
          return [[Key], [assert.type.number], [assert.type.boolean], [Key]];
        }});
      Object.defineProperty(ElementInjector.prototype._appInjector, "parameters", {get: function() {
          return [[Key]];
        }});
      Object.defineProperty(ElementInjector.prototype._shouldIncludeSelf, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ElementInjector.prototype._getPreBuiltObjectByKeyId, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ElementInjector.prototype._getDirectiveByKeyId, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ElementInjector.prototype.getDirectiveAtIndex, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ElementInjector.prototype.getDirectiveBindingAtIndex, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(ElementInjector.prototype.hasEventEmitter, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      OutOfBoundsAccess = (function($__super) {
        var OutOfBoundsAccess = function OutOfBoundsAccess(index) {
          $traceurRuntime.superConstructor(OutOfBoundsAccess).call(this);
          this.message = ("Index " + index + " is out-of-bounds.");
        };
        return ($traceurRuntime.createClass)(OutOfBoundsAccess, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error));
    }
  };
});

System.register("angular2/src/change_detection/parser/lexer", ["angular2/di", "angular2/src/facade/collection", "angular2/src/facade/lang"], function($__export) {
  "";
  var __moduleName = "angular2/src/change_detection/parser/lexer";
  var Injectable,
      List,
      ListWrapper,
      SetWrapper,
      int,
      NumberWrapper,
      StringJoiner,
      StringWrapper,
      TOKEN_TYPE_CHARACTER,
      TOKEN_TYPE_IDENTIFIER,
      TOKEN_TYPE_KEYWORD,
      TOKEN_TYPE_STRING,
      TOKEN_TYPE_OPERATOR,
      TOKEN_TYPE_NUMBER,
      Lexer,
      Token,
      EOF,
      $EOF,
      $TAB,
      $LF,
      $VTAB,
      $FF,
      $CR,
      $SPACE,
      $BANG,
      $DQ,
      $HASH,
      $$,
      $PERCENT,
      $AMPERSAND,
      $SQ,
      $LPAREN,
      $RPAREN,
      $STAR,
      $PLUS,
      $COMMA,
      $MINUS,
      $PERIOD,
      $SLASH,
      $COLON,
      $SEMICOLON,
      $LT,
      $EQ,
      $GT,
      $QUESTION,
      $0,
      $9,
      $A,
      $B,
      $C,
      $D,
      $E,
      $F,
      $G,
      $H,
      $I,
      $J,
      $K,
      $L,
      $M,
      $N,
      $O,
      $P,
      $Q,
      $R,
      $S,
      $T,
      $U,
      $V,
      $W,
      $X,
      $Y,
      $Z,
      $LBRACKET,
      $BACKSLASH,
      $RBRACKET,
      $CARET,
      $_,
      $a,
      $b,
      $c,
      $d,
      $e,
      $f,
      $g,
      $h,
      $i,
      $j,
      $k,
      $l,
      $m,
      $n,
      $o,
      $p,
      $q,
      $r,
      $s,
      $t,
      $u,
      $v,
      $w,
      $x,
      $y,
      $z,
      $LBRACE,
      $BAR,
      $RBRACE,
      $TILDE,
      $NBSP,
      ScannerError,
      _Scanner,
      OPERATORS,
      KEYWORDS;
  function newCharacterToken(index, code) {
    return new Token(index, TOKEN_TYPE_CHARACTER, code, StringWrapper.fromCharCode(code));
  }
  function newIdentifierToken(index, text) {
    return new Token(index, TOKEN_TYPE_IDENTIFIER, 0, text);
  }
  function newKeywordToken(index, text) {
    return new Token(index, TOKEN_TYPE_KEYWORD, 0, text);
  }
  function newOperatorToken(index, text) {
    return new Token(index, TOKEN_TYPE_OPERATOR, 0, text);
  }
  function newStringToken(index, text) {
    return new Token(index, TOKEN_TYPE_STRING, 0, text);
  }
  function newNumberToken(index, n) {
    return new Token(index, TOKEN_TYPE_NUMBER, n, "");
  }
  function isWhitespace(code) {
    return (code >= $TAB && code <= $SPACE) || (code == $NBSP);
  }
  function isIdentifierStart(code) {
    return ($a <= code && code <= $z) || ($A <= code && code <= $Z) || (code == $_) || (code == $$);
  }
  function isIdentifierPart(code) {
    return ($a <= code && code <= $z) || ($A <= code && code <= $Z) || ($0 <= code && code <= $9) || (code == $_) || (code == $$);
  }
  function isDigit(code) {
    return $0 <= code && code <= $9;
  }
  function isExponentStart(code) {
    return code == $e || code == $E;
  }
  function isExponentSign(code) {
    return code == $MINUS || code == $PLUS;
  }
  function unescape(code) {
    switch (code) {
      case $n:
        return $LF;
      case $f:
        return $FF;
      case $r:
        return $CR;
      case $t:
        return $TAB;
      case $v:
        return $VTAB;
      default:
        return code;
    }
  }
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      SetWrapper = $__m.SetWrapper;
    }, function($__m) {
      int = $__m.int;
      NumberWrapper = $__m.NumberWrapper;
      StringJoiner = $__m.StringJoiner;
      StringWrapper = $__m.StringWrapper;
    }],
    execute: function() {
      TOKEN_TYPE_CHARACTER = $__export("TOKEN_TYPE_CHARACTER", 1);
      TOKEN_TYPE_IDENTIFIER = $__export("TOKEN_TYPE_IDENTIFIER", 2);
      TOKEN_TYPE_KEYWORD = $__export("TOKEN_TYPE_KEYWORD", 3);
      TOKEN_TYPE_STRING = $__export("TOKEN_TYPE_STRING", 4);
      TOKEN_TYPE_OPERATOR = $__export("TOKEN_TYPE_OPERATOR", 5);
      TOKEN_TYPE_NUMBER = $__export("TOKEN_TYPE_NUMBER", 6);
      Lexer = $__export("Lexer", (function() {
        var Lexer = function Lexer() {
          ;
        };
        return ($traceurRuntime.createClass)(Lexer, {tokenize: function(text) {
            var scanner = new _Scanner(text);
            var tokens = [];
            var token = scanner.scanToken();
            while (token != null) {
              ListWrapper.push(tokens, token);
              token = scanner.scanToken();
            }
            return tokens;
          }}, {});
      }()));
      Object.defineProperty(Lexer, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(Lexer.prototype.tokenize, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Token = $__export("Token", (function() {
        var Token = function Token(index, type, numValue, strValue) {
          this.index = index;
          this.type = type;
          this._numValue = numValue;
          this._strValue = strValue;
        };
        return ($traceurRuntime.createClass)(Token, {
          isCharacter: function(code) {
            return (this.type == TOKEN_TYPE_CHARACTER && this._numValue == code);
          },
          isNumber: function() {
            return (this.type == TOKEN_TYPE_NUMBER);
          },
          isString: function() {
            return (this.type == TOKEN_TYPE_STRING);
          },
          isOperator: function(operater) {
            return (this.type == TOKEN_TYPE_OPERATOR && this._strValue == operater);
          },
          isIdentifier: function() {
            return (this.type == TOKEN_TYPE_IDENTIFIER);
          },
          isKeyword: function() {
            return (this.type == TOKEN_TYPE_KEYWORD);
          },
          isKeywordVar: function() {
            return (this.type == TOKEN_TYPE_KEYWORD && this._strValue == "var");
          },
          isKeywordNull: function() {
            return (this.type == TOKEN_TYPE_KEYWORD && this._strValue == "null");
          },
          isKeywordUndefined: function() {
            return (this.type == TOKEN_TYPE_KEYWORD && this._strValue == "undefined");
          },
          isKeywordTrue: function() {
            return (this.type == TOKEN_TYPE_KEYWORD && this._strValue == "true");
          },
          isKeywordFalse: function() {
            return (this.type == TOKEN_TYPE_KEYWORD && this._strValue == "false");
          },
          toNumber: function() {
            return (this.type == TOKEN_TYPE_NUMBER) ? this._numValue : -1;
          },
          toString: function() {
            var type = this.type;
            if (type >= TOKEN_TYPE_CHARACTER && type <= TOKEN_TYPE_STRING) {
              return this._strValue;
            } else if (type == TOKEN_TYPE_NUMBER) {
              return this._numValue.toString();
            } else {
              return null;
            }
          }
        }, {});
      }()));
      Object.defineProperty(Token, "parameters", {get: function() {
          return [[int], [int], [assert.type.number], [assert.type.string]];
        }});
      Object.defineProperty(Token.prototype.isCharacter, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(Token.prototype.isOperator, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(newCharacterToken, "parameters", {get: function() {
          return [[int], [int]];
        }});
      Object.defineProperty(newIdentifierToken, "parameters", {get: function() {
          return [[int], [assert.type.string]];
        }});
      Object.defineProperty(newKeywordToken, "parameters", {get: function() {
          return [[int], [assert.type.string]];
        }});
      Object.defineProperty(newOperatorToken, "parameters", {get: function() {
          return [[int], [assert.type.string]];
        }});
      Object.defineProperty(newStringToken, "parameters", {get: function() {
          return [[int], [assert.type.string]];
        }});
      Object.defineProperty(newNumberToken, "parameters", {get: function() {
          return [[int], [assert.type.number]];
        }});
      EOF = $__export("EOF", new Token(-1, 0, 0, ""));
      $EOF = $__export("$EOF", 0);
      $TAB = $__export("$TAB", 9);
      $LF = $__export("$LF", 10);
      $VTAB = $__export("$VTAB", 11);
      $FF = $__export("$FF", 12);
      $CR = $__export("$CR", 13);
      $SPACE = $__export("$SPACE", 32);
      $BANG = $__export("$BANG", 33);
      $DQ = $__export("$DQ", 34);
      $HASH = $__export("$HASH", 35);
      $$ = $__export("$$", 36);
      $PERCENT = $__export("$PERCENT", 37);
      $AMPERSAND = $__export("$AMPERSAND", 38);
      $SQ = $__export("$SQ", 39);
      $LPAREN = $__export("$LPAREN", 40);
      $RPAREN = $__export("$RPAREN", 41);
      $STAR = $__export("$STAR", 42);
      $PLUS = $__export("$PLUS", 43);
      $COMMA = $__export("$COMMA", 44);
      $MINUS = $__export("$MINUS", 45);
      $PERIOD = $__export("$PERIOD", 46);
      $SLASH = $__export("$SLASH", 47);
      $COLON = $__export("$COLON", 58);
      $SEMICOLON = $__export("$SEMICOLON", 59);
      $LT = $__export("$LT", 60);
      $EQ = $__export("$EQ", 61);
      $GT = $__export("$GT", 62);
      $QUESTION = $__export("$QUESTION", 63);
      $0 = 48;
      $9 = 57;
      $A = 65, $B = 66, $C = 67, $D = 68, $E = 69, $F = 70, $G = 71, $H = 72, $I = 73, $J = 74, $K = 75, $L = 76, $M = 77, $N = 78, $O = 79, $P = 80, $Q = 81, $R = 82, $S = 83, $T = 84, $U = 85, $V = 86, $W = 87, $X = 88, $Y = 89, $Z = 90;
      $LBRACKET = $__export("$LBRACKET", 91);
      $BACKSLASH = $__export("$BACKSLASH", 92);
      $RBRACKET = $__export("$RBRACKET", 93);
      $CARET = 94;
      $_ = 95;
      $a = 97, $b = 98, $c = 99, $d = 100, $e = 101, $f = 102, $g = 103, $h = 104, $i = 105, $j = 106, $k = 107, $l = 108, $m = 109, $n = 110, $o = 111, $p = 112, $q = 113, $r = 114, $s = 115, $t = 116, $u = 117, $v = 118, $w = 119, $x = 120, $y = 121, $z = 122;
      $LBRACE = $__export("$LBRACE", 123);
      $BAR = $__export("$BAR", 124);
      $RBRACE = $__export("$RBRACE", 125);
      $TILDE = 126;
      $NBSP = 160;
      ScannerError = $__export("ScannerError", (function($__super) {
        var ScannerError = function ScannerError(message) {
          $traceurRuntime.superConstructor(ScannerError).call(this);
          this.message = message;
        };
        return ($traceurRuntime.createClass)(ScannerError, {toString: function() {
            return this.message;
          }}, {}, $__super);
      }(Error)));
      _Scanner = (function() {
        var _Scanner = function _Scanner(input) {
          this.input = input;
          this.length = input.length;
          this.peek = 0;
          this.index = -1;
          this.advance();
        };
        return ($traceurRuntime.createClass)(_Scanner, {
          advance: function() {
            this.peek = ++this.index >= this.length ? $EOF : StringWrapper.charCodeAt(this.input, this.index);
          },
          scanToken: function() {
            var input = this.input,
                length = this.length,
                peek = this.peek,
                index = this.index;
            while (peek <= $SPACE) {
              if (++index >= length) {
                peek = $EOF;
                break;
              } else {
                peek = StringWrapper.charCodeAt(input, index);
              }
            }
            this.peek = peek;
            this.index = index;
            if (index >= length) {
              return null;
            }
            if (isIdentifierStart(peek))
              return this.scanIdentifier();
            if (isDigit(peek))
              return this.scanNumber(index);
            var start = index;
            switch (peek) {
              case $PERIOD:
                this.advance();
                return isDigit(this.peek) ? this.scanNumber(start) : newCharacterToken(start, $PERIOD);
              case $LPAREN:
              case $RPAREN:
              case $LBRACE:
              case $RBRACE:
              case $LBRACKET:
              case $RBRACKET:
              case $COMMA:
              case $COLON:
              case $SEMICOLON:
                return this.scanCharacter(start, peek);
              case $SQ:
              case $DQ:
                return this.scanString();
              case $HASH:
                return this.scanOperator(start, StringWrapper.fromCharCode(peek));
              case $PLUS:
              case $MINUS:
              case $STAR:
              case $SLASH:
              case $PERCENT:
              case $CARET:
              case $QUESTION:
                return this.scanOperator(start, StringWrapper.fromCharCode(peek));
              case $LT:
              case $GT:
              case $BANG:
              case $EQ:
                return this.scanComplexOperator(start, $EQ, StringWrapper.fromCharCode(peek), '=');
              case $AMPERSAND:
                return this.scanComplexOperator(start, $AMPERSAND, '&', '&');
              case $BAR:
                return this.scanComplexOperator(start, $BAR, '|', '|');
              case $TILDE:
                return this.scanComplexOperator(start, $SLASH, '~', '/');
              case $NBSP:
                while (isWhitespace(this.peek))
                  this.advance();
                return this.scanToken();
            }
            this.error(("Unexpected character [" + StringWrapper.fromCharCode(peek) + "]"), 0);
            return null;
          },
          scanCharacter: function(start, code) {
            assert(this.peek == code);
            this.advance();
            return newCharacterToken(start, code);
          },
          scanOperator: function(start, str) {
            assert(this.peek == StringWrapper.charCodeAt(str, 0));
            assert(SetWrapper.has(OPERATORS, str));
            this.advance();
            return newOperatorToken(start, str);
          },
          scanComplexOperator: function(start, code, one, two) {
            assert(this.peek == StringWrapper.charCodeAt(one, 0));
            this.advance();
            var str = one;
            if (this.peek == code) {
              this.advance();
              str += two;
            }
            assert(SetWrapper.has(OPERATORS, str));
            return newOperatorToken(start, str);
          },
          scanIdentifier: function() {
            assert(isIdentifierStart(this.peek));
            var start = this.index;
            this.advance();
            while (isIdentifierPart(this.peek))
              this.advance();
            var str = this.input.substring(start, this.index);
            if (SetWrapper.has(KEYWORDS, str)) {
              return newKeywordToken(start, str);
            } else {
              return newIdentifierToken(start, str);
            }
          },
          scanNumber: function(start) {
            assert(isDigit(this.peek));
            var simple = (this.index === start);
            this.advance();
            while (true) {
              if (isDigit(this.peek)) {} else if (this.peek == $PERIOD) {
                simple = false;
              } else if (isExponentStart(this.peek)) {
                this.advance();
                if (isExponentSign(this.peek))
                  this.advance();
                if (!isDigit(this.peek))
                  this.error('Invalid exponent', -1);
                simple = false;
              } else {
                break;
              }
              this.advance();
            }
            var str = this.input.substring(start, this.index);
            var value = simple ? NumberWrapper.parseIntAutoRadix(str) : NumberWrapper.parseFloat(str);
            return newNumberToken(start, value);
          },
          scanString: function() {
            assert(this.peek == $SQ || this.peek == $DQ);
            var start = this.index;
            var quote = this.peek;
            this.advance();
            var buffer;
            var marker = this.index;
            var input = this.input;
            while (this.peek != quote) {
              if (this.peek == $BACKSLASH) {
                if (buffer == null)
                  buffer = new StringJoiner();
                buffer.add(input.substring(marker, this.index));
                this.advance();
                var unescapedCode = void 0;
                if (this.peek == $u) {
                  var hex = input.substring(this.index + 1, this.index + 5);
                  try {
                    unescapedCode = NumberWrapper.parseInt(hex, 16);
                  } catch (e) {
                    this.error(("Invalid unicode escape [\\u" + hex + "]"), 0);
                  }
                  for (var i = 0; i < 5; i++) {
                    this.advance();
                  }
                } else {
                  unescapedCode = unescape(this.peek);
                  this.advance();
                }
                buffer.add(StringWrapper.fromCharCode(unescapedCode));
                marker = this.index;
              } else if (this.peek == $EOF) {
                this.error('Unterminated quote', 0);
              } else {
                this.advance();
              }
            }
            var last = input.substring(marker, this.index);
            this.advance();
            var unescaped = last;
            if (buffer != null) {
              buffer.add(last);
              unescaped = buffer.toString();
            }
            return newStringToken(start, unescaped);
          },
          error: function(message, offset) {
            var position = this.index + offset;
            throw new ScannerError(("Lexer Error: " + message + " at column " + position + " in expression [" + this.input + "]"));
          }
        }, {});
      }());
      Object.defineProperty(_Scanner, "parameters", {get: function() {
          return [[assert.type.string]];
        }});
      Object.defineProperty(_Scanner.prototype.scanCharacter, "parameters", {get: function() {
          return [[int], [int]];
        }});
      Object.defineProperty(_Scanner.prototype.scanOperator, "parameters", {get: function() {
          return [[int], [assert.type.string]];
        }});
      Object.defineProperty(_Scanner.prototype.scanComplexOperator, "parameters", {get: function() {
          return [[int], [int], [assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(_Scanner.prototype.scanNumber, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(_Scanner.prototype.error, "parameters", {get: function() {
          return [[assert.type.string], [int]];
        }});
      Object.defineProperty(isWhitespace, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(isIdentifierStart, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(isIdentifierPart, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(isDigit, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(isExponentStart, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(isExponentSign, "parameters", {get: function() {
          return [[int]];
        }});
      Object.defineProperty(unescape, "parameters", {get: function() {
          return [[int]];
        }});
      OPERATORS = SetWrapper.createFromList(['+', '-', '*', '/', '~/', '%', '^', '=', '==', '!=', '<', '>', '<=', '>=', '&&', '||', '&', '|', '!', '?', '#']);
      KEYWORDS = SetWrapper.createFromList(['var', 'null', 'undefined', 'true', 'false']);
    }
  };
});

System.register("angular2/src/core/compiler/view", ["angular2/src/dom/dom_adapter", "angular2/src/facade/async", "angular2/src/facade/collection", "angular2/change_detection", "angular2/src/core/compiler/element_injector", "angular2/src/core/compiler/element_binder", "angular2/src/core/compiler/directive_metadata", "angular2/src/reflection/types", "angular2/src/facade/lang", "angular2/di", "angular2/src/core/dom/element", "angular2/src/core/compiler/view_container", "angular2/src/core/compiler/shadow_dom_emulation/light_dom", "angular2/src/core/compiler/shadow_dom_emulation/content_tag", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/core/compiler/view_pool", "angular2/src/render/dom/events/event_manager"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/view";
  var DOM,
      Promise,
      ListWrapper,
      MapWrapper,
      Map,
      StringMapWrapper,
      List,
      AST,
      Locals,
      ChangeDispatcher,
      ProtoChangeDetector,
      ChangeDetector,
      ChangeRecord,
      BindingRecord,
      BindingPropagationConfig,
      uninitialized,
      ProtoElementInjector,
      ElementInjector,
      PreBuiltObjects,
      ElementBinder,
      DirectiveMetadata,
      SetterFn,
      IMPLEMENTS,
      int,
      isPresent,
      isBlank,
      BaseException,
      Injector,
      NgElement,
      ViewContainer,
      LightDom,
      Content,
      ShadowDomStrategy,
      ViewPool,
      EventManager,
      NG_BINDING_CLASS,
      NG_BINDING_CLASS_SELECTOR,
      VIEW_POOL_CAPACITY,
      VIEW_POOL_PREFILL,
      View,
      ProtoView,
      ElementBindingMemento,
      DirectiveBindingMemento,
      DirectiveMemento,
      PropertyUpdate;
  return {
    setters: [function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      Promise = $__m.Promise;
    }, function($__m) {
      ListWrapper = $__m.ListWrapper;
      MapWrapper = $__m.MapWrapper;
      Map = $__m.Map;
      StringMapWrapper = $__m.StringMapWrapper;
      List = $__m.List;
    }, function($__m) {
      AST = $__m.AST;
      Locals = $__m.Locals;
      ChangeDispatcher = $__m.ChangeDispatcher;
      ProtoChangeDetector = $__m.ProtoChangeDetector;
      ChangeDetector = $__m.ChangeDetector;
      ChangeRecord = $__m.ChangeRecord;
      BindingRecord = $__m.BindingRecord;
      BindingPropagationConfig = $__m.BindingPropagationConfig;
      uninitialized = $__m.uninitialized;
    }, function($__m) {
      ProtoElementInjector = $__m.ProtoElementInjector;
      ElementInjector = $__m.ElementInjector;
      PreBuiltObjects = $__m.PreBuiltObjects;
    }, function($__m) {
      ElementBinder = $__m.ElementBinder;
    }, function($__m) {
      DirectiveMetadata = $__m.DirectiveMetadata;
    }, function($__m) {
      SetterFn = $__m.SetterFn;
    }, function($__m) {
      IMPLEMENTS = $__m.IMPLEMENTS;
      int = $__m.int;
      isPresent = $__m.isPresent;
      isBlank = $__m.isBlank;
      BaseException = $__m.BaseException;
    }, function($__m) {
      Injector = $__m.Injector;
    }, function($__m) {
      NgElement = $__m.NgElement;
    }, function($__m) {
      ViewContainer = $__m.ViewContainer;
    }, function($__m) {
      LightDom = $__m.LightDom;
    }, function($__m) {
      Content = $__m.Content;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      ViewPool = $__m.ViewPool;
    }, function($__m) {
      EventManager = $__m.EventManager;
    }],
    execute: function() {
      NG_BINDING_CLASS = 'ng-binding';
      NG_BINDING_CLASS_SELECTOR = '.ng-binding';
      VIEW_POOL_CAPACITY = 10000;
      VIEW_POOL_PREFILL = 0;
      View = $__export("View", (function() {
        var View = function View(proto, nodes, protoLocals) {
          this.proto = proto;
          this.nodes = nodes;
          this.changeDetector = null;
          this.elementInjectors = null;
          this.rootElementInjectors = null;
          this.textNodes = null;
          this.bindElements = null;
          this.componentChildViews = null;
          this.viewContainers = null;
          this.contentTags = null;
          this.preBuiltObjects = null;
          this.lightDoms = null;
          this.context = null;
          this.locals = new Locals(null, MapWrapper.clone(protoLocals));
        };
        return ($traceurRuntime.createClass)(View, {
          init: function(changeDetector, elementInjectors, rootElementInjectors, textNodes, bindElements, viewContainers, contentTags, preBuiltObjects, componentChildViews, lightDoms) {
            this.changeDetector = changeDetector;
            this.elementInjectors = elementInjectors;
            this.rootElementInjectors = rootElementInjectors;
            this.textNodes = textNodes;
            this.bindElements = bindElements;
            this.viewContainers = viewContainers;
            this.contentTags = contentTags;
            this.preBuiltObjects = preBuiltObjects;
            this.componentChildViews = componentChildViews;
            this.lightDoms = lightDoms;
          },
          setLocal: function(contextName, value) {
            if (!this.hydrated())
              throw new BaseException('Cannot set locals on dehydrated view.');
            if (!MapWrapper.contains(this.proto.variableBindings, contextName)) {
              return ;
            }
            var templateName = MapWrapper.get(this.proto.variableBindings, contextName);
            this.locals.set(templateName, value);
          },
          hydrated: function() {
            return isPresent(this.context);
          },
          _hydrateContext: function(newContext, locals) {
            this.context = newContext;
            this.locals.parent = locals;
            this.changeDetector.hydrate(this.context, this.locals);
          },
          _dehydrateContext: function() {
            if (isPresent(this.locals)) {
              this.locals.clearValues();
            }
            this.context = null;
            this.changeDetector.dehydrate();
          },
          hydrate: function(appInjector, hostElementInjector, hostLightDom, context, locals) {
            if (this.hydrated())
              throw new BaseException('The view is already hydrated.');
            this._hydrateContext(context, locals);
            for (var i = 0; i < this.viewContainers.length; i++) {
              var vc = this.viewContainers[i];
              if (isPresent(vc)) {
                vc.hydrate(appInjector, hostElementInjector, hostLightDom);
              }
            }
            var binders = this.proto.elementBinders;
            var componentChildViewIndex = 0;
            for (var i = 0; i < binders.length; ++i) {
              var componentDirective = binders[i].componentDirective;
              var shadowDomAppInjector = null;
              if (isPresent(componentDirective)) {
                var services = componentDirective.annotation.services;
                if (isPresent(services))
                  shadowDomAppInjector = appInjector.createChild(services);
                else {
                  shadowDomAppInjector = appInjector;
                }
              } else {
                shadowDomAppInjector = null;
              }
              var elementInjector = this.elementInjectors[i];
              if (isPresent(elementInjector)) {
                elementInjector.instantiateDirectives(appInjector, shadowDomAppInjector, this.preBuiltObjects[i]);
                var exportImplicitName = elementInjector.getExportImplicitName();
                if (elementInjector.isExportingComponent()) {
                  this.locals.set(exportImplicitName, elementInjector.getComponent());
                } else if (elementInjector.isExportingElement()) {
                  this.locals.set(exportImplicitName, elementInjector.getNgElement().domElement);
                }
              }
              if (isPresent(binders[i].nestedProtoView) && isPresent(componentDirective)) {
                this.componentChildViews[componentChildViewIndex++].hydrate(shadowDomAppInjector, elementInjector, this.lightDoms[i], elementInjector.getComponent(), null);
              }
            }
            for (var i = 0; i < this.lightDoms.length; ++i) {
              var lightDom = this.lightDoms[i];
              if (isPresent(lightDom)) {
                lightDom.redistribute();
              }
            }
          },
          dehydrate: function() {
            for (var i = 0; i < this.componentChildViews.length; i++) {
              this.componentChildViews[i].dehydrate();
            }
            for (var i = 0; i < this.elementInjectors.length; i++) {
              if (isPresent(this.elementInjectors[i])) {
                this.elementInjectors[i].clearDirectives();
              }
            }
            if (isPresent(this.viewContainers)) {
              for (var i = 0; i < this.viewContainers.length; i++) {
                var vc = this.viewContainers[i];
                if (isPresent(vc)) {
                  vc.dehydrate();
                }
              }
            }
            this._dehydrateContext();
          },
          triggerEventHandlers: function(eventName, eventObj, binderIndex) {
            var handlers = this.proto.eventHandlers[binderIndex];
            if (isBlank(handlers))
              return ;
            var handler = StringMapWrapper.get(handlers, eventName);
            if (isBlank(handler))
              return ;
            handler(eventObj, this);
          },
          onRecordChange: function(directiveMemento, records) {
            this._invokeMementos(records);
            if (directiveMemento instanceof DirectiveMemento) {
              this._notifyDirectiveAboutChanges(directiveMemento, records);
            }
          },
          onAllChangesDone: function(directiveMemento) {
            var dir = directiveMemento.directive(this.elementInjectors);
            dir.onAllChangesDone();
          },
          _invokeMementos: function(records) {
            for (var i = 0; i < records.length; ++i) {
              this._invokeMementoFor(records[i]);
            }
          },
          _notifyDirectiveAboutChanges: function(directiveMemento, records) {
            var dir = directiveMemento.directive(this.elementInjectors);
            if (directiveMemento.callOnChange) {
              dir.onChange(this._collectChanges(records));
            }
          },
          _invokeMementoFor: function(record) {
            var memento = record.bindingMemento;
            if (memento instanceof DirectiveBindingMemento) {
              var directiveMemento = memento;
              directiveMemento.invoke(record, this.elementInjectors);
            } else if (memento instanceof ElementBindingMemento) {
              var elementMemento = memento;
              elementMemento.invoke(record, this.bindElements);
            } else {
              var textNodeIndex = memento;
              DOM.setText(this.textNodes[textNodeIndex], record.currentValue);
            }
          },
          _collectChanges: function(records) {
            var changes = StringMapWrapper.create();
            for (var i = 0; i < records.length; ++i) {
              var record = records[i];
              var propertyUpdate = new PropertyUpdate(record.currentValue, record.previousValue);
              StringMapWrapper.set(changes, record.bindingMemento._setterName, propertyUpdate);
            }
            return changes;
          }
        }, {});
      }()));
      Object.defineProperty(View, "annotations", {get: function() {
          return [new IMPLEMENTS(ChangeDispatcher)];
        }});
      Object.defineProperty(View, "parameters", {get: function() {
          return [[ProtoView], [List], [Map]];
        }});
      Object.defineProperty(View.prototype.init, "parameters", {get: function() {
          return [[ChangeDetector], [List], [List], [List], [List], [List], [List], [List], [List], [assert.genericType(List, LightDom)]];
        }});
      Object.defineProperty(View.prototype.setLocal, "parameters", {get: function() {
          return [[assert.type.string], []];
        }});
      Object.defineProperty(View.prototype.hydrate, "parameters", {get: function() {
          return [[Injector], [ElementInjector], [LightDom], [Object], [Locals]];
        }});
      Object.defineProperty(View.prototype.triggerEventHandlers, "parameters", {get: function() {
          return [[assert.type.string], [], [int]];
        }});
      Object.defineProperty(View.prototype.onRecordChange, "parameters", {get: function() {
          return [[], [List]];
        }});
      Object.defineProperty(View.prototype._invokeMementos, "parameters", {get: function() {
          return [[List]];
        }});
      Object.defineProperty(View.prototype._notifyDirectiveAboutChanges, "parameters", {get: function() {
          return [[], [List]];
        }});
      Object.defineProperty(View.prototype._invokeMementoFor, "parameters", {get: function() {
          return [[ChangeRecord]];
        }});
      Object.defineProperty(View.prototype._collectChanges, "parameters", {get: function() {
          return [[List]];
        }});
      ProtoView = $__export("ProtoView", (function() {
        var ProtoView = function ProtoView(template, protoChangeDetector, shadowDomStrategy) {
          var parentProtoView = arguments[3] !== (void 0) ? arguments[3] : null;
          this.element = template;
          this.elementBinders = [];
          this.variableBindings = MapWrapper.create();
          this.protoLocals = MapWrapper.create();
          this.protoChangeDetector = protoChangeDetector;
          this.parentProtoView = parentProtoView;
          this.textNodesWithBindingCount = 0;
          this.elementsWithBindingCount = 0;
          this.instantiateInPlace = false;
          this.rootBindingOffset = (isPresent(this.element) && DOM.hasClass(this.element, NG_BINDING_CLASS)) ? 1 : 0;
          this.isTemplateElement = DOM.isTemplateElement(this.element);
          this.shadowDomStrategy = shadowDomStrategy;
          this._viewPool = new ViewPool(VIEW_POOL_CAPACITY);
          this.stylePromises = [];
          this.eventHandlers = [];
          this.bindingRecords = [];
          this._directiveMementosMap = MapWrapper.create();
          this._variableBindings = null;
          this._directiveMementos = null;
        };
        return ($traceurRuntime.createClass)(ProtoView, {
          instantiate: function(hostElementInjector, eventManager) {
            if (this._viewPool.length() == 0)
              this._preFillPool(hostElementInjector, eventManager);
            var view = this._viewPool.pop();
            return isPresent(view) ? view : this._instantiate(hostElementInjector, eventManager);
          },
          _preFillPool: function(hostElementInjector, eventManager) {
            for (var i = 0; i < VIEW_POOL_PREFILL; i++) {
              this._viewPool.push(this._instantiate(hostElementInjector, eventManager));
            }
          },
          _getVariableBindings: function() {
            var $__0 = this;
            if (isPresent(this._variableBindings)) {
              return this._variableBindings;
            }
            this._variableBindings = isPresent(this.parentProtoView) ? ListWrapper.clone(this.parentProtoView._getVariableBindings()) : [];
            MapWrapper.forEach(this.protoLocals, (function(v, local) {
              ListWrapper.push($__0._variableBindings, local);
            }));
            return this._variableBindings;
          },
          _getDirectiveMementos: function() {
            if (isPresent(this._directiveMementos)) {
              return this._directiveMementos;
            }
            this._directiveMementos = [];
            for (var injectorIndex = 0; injectorIndex < this.elementBinders.length; ++injectorIndex) {
              var pei = this.elementBinders[injectorIndex].protoElementInjector;
              if (isPresent(pei)) {
                for (var directiveIndex = 0; directiveIndex < pei.numberOfDirectives; ++directiveIndex) {
                  ListWrapper.push(this._directiveMementos, this._getDirectiveMemento(injectorIndex, directiveIndex));
                }
              }
            }
            return this._directiveMementos;
          },
          _instantiate: function(hostElementInjector, eventManager) {
            var rootElementClone = this.instantiateInPlace ? this.element : DOM.importIntoDoc(this.element);
            var elementsWithBindingsDynamic;
            if (this.isTemplateElement) {
              elementsWithBindingsDynamic = DOM.querySelectorAll(DOM.content(rootElementClone), NG_BINDING_CLASS_SELECTOR);
            } else {
              elementsWithBindingsDynamic = DOM.getElementsByClassName(rootElementClone, NG_BINDING_CLASS);
            }
            var elementsWithBindings = ListWrapper.createFixedSize(elementsWithBindingsDynamic.length);
            for (var binderIdx = 0; binderIdx < elementsWithBindingsDynamic.length; ++binderIdx) {
              elementsWithBindings[binderIdx] = elementsWithBindingsDynamic[binderIdx];
            }
            var viewNodes;
            if (this.isTemplateElement) {
              var childNode = DOM.firstChild(DOM.content(rootElementClone));
              viewNodes = [];
              while (childNode != null) {
                ListWrapper.push(viewNodes, childNode);
                childNode = DOM.nextSibling(childNode);
              }
            } else {
              viewNodes = [rootElementClone];
            }
            var view = new View(this, viewNodes, this.protoLocals);
            var changeDetector = this.protoChangeDetector.instantiate(view, this.bindingRecords, this._getVariableBindings(), this._getDirectiveMementos());
            var binders = this.elementBinders;
            var elementInjectors = ListWrapper.createFixedSize(binders.length);
            var eventHandlers = ListWrapper.createFixedSize(binders.length);
            var rootElementInjectors = [];
            var textNodes = [];
            var elementsWithPropertyBindings = [];
            var preBuiltObjects = ListWrapper.createFixedSize(binders.length);
            var viewContainers = ListWrapper.createFixedSize(binders.length);
            var contentTags = ListWrapper.createFixedSize(binders.length);
            var componentChildViews = [];
            var lightDoms = ListWrapper.createFixedSize(binders.length);
            for (var binderIdx = 0; binderIdx < binders.length; binderIdx++) {
              var binder = binders[binderIdx];
              var element = void 0;
              if (binderIdx === 0 && this.rootBindingOffset === 1) {
                element = rootElementClone;
              } else {
                element = elementsWithBindings[binderIdx - this.rootBindingOffset];
              }
              var elementInjector = null;
              var protoElementInjector = binder.protoElementInjector;
              if (isPresent(protoElementInjector)) {
                if (isPresent(protoElementInjector.parent)) {
                  var parentElementInjector = elementInjectors[protoElementInjector.parent.index];
                  elementInjector = protoElementInjector.instantiate(parentElementInjector, null);
                } else {
                  elementInjector = protoElementInjector.instantiate(null, hostElementInjector);
                  ListWrapper.push(rootElementInjectors, elementInjector);
                }
              }
              elementInjectors[binderIdx] = elementInjector;
              if (binder.hasElementPropertyBindings) {
                ListWrapper.push(elementsWithPropertyBindings, element);
              }
              var textNodeIndices = binder.textNodeIndices;
              if (isPresent(textNodeIndices)) {
                var childNode = DOM.firstChild(DOM.templateAwareRoot(element));
                for (var j = 0,
                    k = 0; j < textNodeIndices.length; j++) {
                  for (var index = textNodeIndices[j]; k < index; k++) {
                    childNode = DOM.nextSibling(childNode);
                  }
                  ListWrapper.push(textNodes, childNode);
                }
              }
              var lightDom = null;
              var bindingPropagationConfig = null;
              if (isPresent(binder.nestedProtoView) && isPresent(binder.componentDirective)) {
                var strategy = this.shadowDomStrategy;
                var childView = binder.nestedProtoView.instantiate(elementInjector, eventManager);
                changeDetector.addChild(childView.changeDetector);
                lightDom = strategy.constructLightDom(view, childView, element);
                strategy.attachTemplate(element, childView);
                bindingPropagationConfig = new BindingPropagationConfig(childView.changeDetector);
                ListWrapper.push(componentChildViews, childView);
              }
              lightDoms[binderIdx] = lightDom;
              var destLightDom = null;
              if (isPresent(binder.parent) && binder.distanceToParent === 1) {
                destLightDom = lightDoms[binder.parent.index];
              }
              var viewContainer = null;
              if (isPresent(binder.viewportDirective)) {
                viewContainer = new ViewContainer(view, element, binder.nestedProtoView, elementInjector, eventManager, destLightDom);
              }
              viewContainers[binderIdx] = viewContainer;
              var contentTag = null;
              if (isPresent(binder.contentTagSelector)) {
                contentTag = new Content(destLightDom, element, binder.contentTagSelector);
              }
              contentTags[binderIdx] = contentTag;
              if (isPresent(elementInjector)) {
                preBuiltObjects[binderIdx] = new PreBuiltObjects(view, new NgElement(element), viewContainer, bindingPropagationConfig);
              }
              if (isPresent(binder.events)) {
                eventHandlers[binderIdx] = StringMapWrapper.create();
                StringMapWrapper.forEach(binder.events, (function(eventMap, eventName) {
                  var handler = ProtoView.buildEventHandler(eventMap, binderIdx);
                  StringMapWrapper.set(eventHandlers[binderIdx], eventName, handler);
                  if (isBlank(elementInjector) || !elementInjector.hasEventEmitter(eventName)) {
                    eventManager.addEventListener(element, eventName, (function(event) {
                      handler(event, view);
                    }));
                  }
                }));
              }
            }
            this.eventHandlers = eventHandlers;
            view.init(changeDetector, elementInjectors, rootElementInjectors, textNodes, elementsWithPropertyBindings, viewContainers, contentTags, preBuiltObjects, componentChildViews, lightDoms);
            return view;
          },
          returnToPool: function(view) {
            this._viewPool.push(view);
          },
          bindVariable: function(contextName, templateName) {
            MapWrapper.set(this.variableBindings, contextName, templateName);
            MapWrapper.set(this.protoLocals, templateName, null);
          },
          bindElement: function(parent, distanceToParent, protoElementInjector) {
            var componentDirective = arguments[3] !== (void 0) ? arguments[3] : null;
            var viewportDirective = arguments[4] !== (void 0) ? arguments[4] : null;
            var elBinder = new ElementBinder(this.elementBinders.length, parent, distanceToParent, protoElementInjector, componentDirective, viewportDirective);
            ListWrapper.push(this.elementBinders, elBinder);
            return elBinder;
          },
          bindTextNode: function(indexInParent, expression) {
            var elBinder = this.elementBinders[this.elementBinders.length - 1];
            if (isBlank(elBinder.textNodeIndices)) {
              elBinder.textNodeIndices = ListWrapper.create();
            }
            ListWrapper.push(elBinder.textNodeIndices, indexInParent);
            var memento = this.textNodesWithBindingCount++;
            ListWrapper.push(this.bindingRecords, new BindingRecord(expression, memento, null));
          },
          bindElementProperty: function(expression, setterName, setter) {
            var elBinder = this.elementBinders[this.elementBinders.length - 1];
            if (!elBinder.hasElementPropertyBindings) {
              elBinder.hasElementPropertyBindings = true;
              this.elementsWithBindingCount++;
            }
            var memento = new ElementBindingMemento(this.elementsWithBindingCount - 1, setterName, setter);
            ListWrapper.push(this.bindingRecords, new BindingRecord(expression, memento, null));
          },
          bindEvent: function(eventName, expression) {
            var directiveIndex = arguments[2] !== (void 0) ? arguments[2] : -1;
            var elBinder = this.elementBinders[this.elementBinders.length - 1];
            var events = elBinder.events;
            if (isBlank(events)) {
              events = StringMapWrapper.create();
              elBinder.events = events;
            }
            var event = StringMapWrapper.get(events, eventName);
            if (isBlank(event)) {
              event = MapWrapper.create();
              StringMapWrapper.set(events, eventName, event);
            }
            MapWrapper.set(event, directiveIndex, expression);
          },
          bindDirectiveProperty: function(directiveIndex, expression, setterName, setter) {
            var elementIndex = this.elementBinders.length - 1;
            var bindingMemento = new DirectiveBindingMemento(elementIndex, directiveIndex, setterName, setter);
            var directiveMemento = this._getDirectiveMemento(elementIndex, directiveIndex);
            ListWrapper.push(this.bindingRecords, new BindingRecord(expression, bindingMemento, directiveMemento));
          },
          _getDirectiveMemento: function(elementInjectorIndex, directiveIndex) {
            var id = elementInjectorIndex * 100 + directiveIndex;
            var protoElementInjector = this.elementBinders[elementInjectorIndex].protoElementInjector;
            if (!MapWrapper.contains(this._directiveMementosMap, id)) {
              var binding = protoElementInjector.getDirectiveBindingAtIndex(directiveIndex);
              MapWrapper.set(this._directiveMementosMap, id, new DirectiveMemento(elementInjectorIndex, directiveIndex, binding.callOnAllChangesDone, binding.callOnChange));
            }
            return MapWrapper.get(this._directiveMementosMap, id);
          }
        }, {
          buildEventHandler: function(eventMap, injectorIdx) {
            var locals = MapWrapper.create();
            return (function(event, view) {
              if (view.hydrated()) {
                MapWrapper.set(locals, '$event', event);
                MapWrapper.forEach(eventMap, (function(expr, directiveIndex) {
                  var context;
                  if (directiveIndex === -1) {
                    context = view.context;
                  } else {
                    context = view.elementInjectors[injectorIdx].getDirectiveAtIndex(directiveIndex);
                  }
                  expr.eval(context, new Locals(view.locals, locals));
                }));
              }
            });
          },
          createRootProtoView: function(protoView, insertionElement, rootComponentAnnotatedType, protoChangeDetector, shadowDomStrategy) {
            DOM.addClass(insertionElement, NG_BINDING_CLASS);
            var cmpType = rootComponentAnnotatedType.type;
            var rootProtoView = new ProtoView(insertionElement, protoChangeDetector, shadowDomStrategy);
            rootProtoView.instantiateInPlace = true;
            var binder = rootProtoView.bindElement(null, 0, new ProtoElementInjector(null, 0, [cmpType], true));
            binder.componentDirective = rootComponentAnnotatedType;
            binder.nestedProtoView = protoView;
            shadowDomStrategy.shimAppElement(rootComponentAnnotatedType, insertionElement);
            return rootProtoView;
          }
        });
      }()));
      Object.defineProperty(ProtoView, "parameters", {get: function() {
          return [[], [ProtoChangeDetector], [ShadowDomStrategy], [ProtoView]];
        }});
      Object.defineProperty(ProtoView.prototype.instantiate, "parameters", {get: function() {
          return [[ElementInjector], [EventManager]];
        }});
      Object.defineProperty(ProtoView.prototype._preFillPool, "parameters", {get: function() {
          return [[ElementInjector], [EventManager]];
        }});
      Object.defineProperty(ProtoView.prototype._instantiate, "parameters", {get: function() {
          return [[ElementInjector], [EventManager]];
        }});
      Object.defineProperty(ProtoView.prototype.returnToPool, "parameters", {get: function() {
          return [[View]];
        }});
      Object.defineProperty(ProtoView.buildEventHandler, "parameters", {get: function() {
          return [[Map], [int]];
        }});
      Object.defineProperty(ProtoView.prototype.bindVariable, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      Object.defineProperty(ProtoView.prototype.bindElement, "parameters", {get: function() {
          return [[ElementBinder], [int], [ProtoElementInjector], [DirectiveMetadata], [DirectiveMetadata]];
        }});
      Object.defineProperty(ProtoView.prototype.bindTextNode, "parameters", {get: function() {
          return [[int], [AST]];
        }});
      Object.defineProperty(ProtoView.prototype.bindElementProperty, "parameters", {get: function() {
          return [[AST], [assert.type.string], [SetterFn]];
        }});
      Object.defineProperty(ProtoView.prototype.bindEvent, "parameters", {get: function() {
          return [[assert.type.string], [AST], [int]];
        }});
      Object.defineProperty(ProtoView.prototype.bindDirectiveProperty, "parameters", {get: function() {
          return [[assert.type.number], [AST], [assert.type.string], [SetterFn]];
        }});
      Object.defineProperty(ProtoView.prototype._getDirectiveMemento, "parameters", {get: function() {
          return [[assert.type.number], [assert.type.number]];
        }});
      Object.defineProperty(ProtoView.createRootProtoView, "parameters", {get: function() {
          return [[ProtoView], [], [DirectiveMetadata], [ProtoChangeDetector], [ShadowDomStrategy]];
        }});
      ElementBindingMemento = $__export("ElementBindingMemento", (function() {
        var ElementBindingMemento = function ElementBindingMemento(elementIndex, setterName, setter) {
          this._elementIndex = elementIndex;
          this._setterName = setterName;
          this._setter = setter;
        };
        return ($traceurRuntime.createClass)(ElementBindingMemento, {invoke: function(record, bindElements) {
            var element = bindElements[this._elementIndex];
            this._setter(element, record.currentValue);
          }}, {});
      }()));
      Object.defineProperty(ElementBindingMemento, "parameters", {get: function() {
          return [[int], [assert.type.string], [SetterFn]];
        }});
      Object.defineProperty(ElementBindingMemento.prototype.invoke, "parameters", {get: function() {
          return [[ChangeRecord], [List]];
        }});
      DirectiveBindingMemento = $__export("DirectiveBindingMemento", (function() {
        var DirectiveBindingMemento = function DirectiveBindingMemento(elementInjectorIndex, directiveIndex, setterName, setter) {
          this._elementInjectorIndex = elementInjectorIndex;
          this._directiveIndex = directiveIndex;
          this._setterName = setterName;
          this._setter = setter;
        };
        return ($traceurRuntime.createClass)(DirectiveBindingMemento, {invoke: function(record, elementInjectors) {
            var elementInjector = elementInjectors[this._elementInjectorIndex];
            var directive = elementInjector.getDirectiveAtIndex(this._directiveIndex);
            this._setter(directive, record.currentValue);
          }}, {});
      }()));
      Object.defineProperty(DirectiveBindingMemento, "parameters", {get: function() {
          return [[assert.type.number], [assert.type.number], [assert.type.string], [SetterFn]];
        }});
      Object.defineProperty(DirectiveBindingMemento.prototype.invoke, "parameters", {get: function() {
          return [[ChangeRecord], [assert.genericType(List, ElementInjector)]];
        }});
      DirectiveMemento = (function() {
        var DirectiveMemento = function DirectiveMemento(elementInjectorIndex, directiveIndex, callOnAllChangesDone, callOnChange) {
          this._elementInjectorIndex = elementInjectorIndex;
          this._directiveIndex = directiveIndex;
          this.callOnAllChangesDone = callOnAllChangesDone;
          this.callOnChange = callOnChange;
        };
        return ($traceurRuntime.createClass)(DirectiveMemento, {directive: function(elementInjectors) {
            var elementInjector = elementInjectors[this._elementInjectorIndex];
            return elementInjector.getDirectiveAtIndex(this._directiveIndex);
          }}, {});
      }());
      Object.defineProperty(DirectiveMemento, "parameters", {get: function() {
          return [[assert.type.number], [assert.type.number], [assert.type.boolean], [assert.type.boolean]];
        }});
      Object.defineProperty(DirectiveMemento.prototype.directive, "parameters", {get: function() {
          return [[assert.genericType(List, ElementInjector)]];
        }});
      PropertyUpdate = $__export("PropertyUpdate", (function() {
        var PropertyUpdate = function PropertyUpdate(currentValue, previousValue) {
          this.currentValue = currentValue;
          this.previousValue = previousValue;
        };
        return ($traceurRuntime.createClass)(PropertyUpdate, {}, {createWithoutPrevious: function(currentValue) {
            return new PropertyUpdate(currentValue, uninitialized);
          }});
      }()));
    }
  };
});

System.register("angular2/change_detection", ["angular2/src/change_detection/parser/ast", "angular2/src/change_detection/parser/lexer", "angular2/src/change_detection/parser/parser", "angular2/src/change_detection/parser/locals", "angular2/src/change_detection/exceptions", "angular2/src/change_detection/interfaces", "angular2/src/change_detection/constants", "angular2/src/change_detection/proto_change_detector", "angular2/src/change_detection/dynamic_change_detector", "angular2/src/change_detection/binding_propagation_config", "angular2/src/change_detection/pipes/pipe_registry", "angular2/src/change_detection/change_detection_util", "angular2/src/change_detection/pipes/pipe", "angular2/src/change_detection/pipes/iterable_changes", "angular2/src/change_detection/pipes/keyvalue_changes", "angular2/src/change_detection/pipes/null_pipe"], function($__export) {
  "";
  var __moduleName = "angular2/change_detection";
  var DynamicProtoChangeDetector,
      JitProtoChangeDetector,
      PipeRegistry,
      IterableChangesFactory,
      KeyValueChangesFactory,
      NullPipeFactory,
      DEFAULT,
      ChangeDetection,
      ProtoChangeDetector,
      defaultPipes,
      DynamicChangeDetection,
      JitChangeDetection,
      _registry,
      dynamicChangeDetection,
      jitChangeDetection;
  var $__exportNames = {
    defaultPipes: true,
    DynamicChangeDetection: true,
    JitChangeDetection: true,
    dynamicChangeDetection: true,
    jitChangeDetection: true,
    undefined: true
  };
  var $__exportNames = {
    defaultPipes: true,
    DynamicChangeDetection: true,
    JitChangeDetection: true,
    dynamicChangeDetection: true,
    jitChangeDetection: true,
    undefined: true
  };
  return {
    setters: [function($__m) {
      $__export("ASTWithSource", $__m.ASTWithSource);
      $__export("AST", $__m.AST);
      $__export("AstTransformer", $__m.AstTransformer);
      $__export("AccessMember", $__m.AccessMember);
      $__export("LiteralArray", $__m.LiteralArray);
      $__export("ImplicitReceiver", $__m.ImplicitReceiver);
    }, function($__m) {
      $__export("Lexer", $__m.Lexer);
    }, function($__m) {
      $__export("Parser", $__m.Parser);
    }, function($__m) {
      $__export("Locals", $__m.Locals);
    }, function($__m) {
      $__export("ExpressionChangedAfterItHasBeenChecked", $__m.ExpressionChangedAfterItHasBeenChecked);
      $__export("ChangeDetectionError", $__m.ChangeDetectionError);
    }, function($__m) {
      ChangeDetection = $__m.ChangeDetection;
      ProtoChangeDetector = $__m.ProtoChangeDetector;
      $__export("ProtoChangeDetector", $__m.ProtoChangeDetector);
      $__export("ChangeRecord", $__m.ChangeRecord);
      $__export("ChangeDispatcher", $__m.ChangeDispatcher);
      $__export("ChangeDetector", $__m.ChangeDetector);
      $__export("ChangeDetection", $__m.ChangeDetection);
    }, function($__m) {
      DEFAULT = $__m.DEFAULT;
      $__export("CHECK_ONCE", $__m.CHECK_ONCE);
      $__export("CHECK_ALWAYS", $__m.CHECK_ALWAYS);
      $__export("DETACHED", $__m.DETACHED);
      $__export("CHECKED", $__m.CHECKED);
      $__export("ON_PUSH", $__m.ON_PUSH);
      $__export("DEFAULT", $__m.DEFAULT);
    }, function($__m) {
      DynamicProtoChangeDetector = $__m.DynamicProtoChangeDetector;
      JitProtoChangeDetector = $__m.JitProtoChangeDetector;
      $__export("DynamicProtoChangeDetector", $__m.DynamicProtoChangeDetector);
      $__export("JitProtoChangeDetector", $__m.JitProtoChangeDetector);
      $__export("BindingRecord", $__m.BindingRecord);
    }, function($__m) {
      $__export("DynamicChangeDetector", $__m.DynamicChangeDetector);
    }, function($__m) {
      $__export("BindingPropagationConfig", $__m.BindingPropagationConfig);
    }, function($__m) {
      PipeRegistry = $__m.PipeRegistry;
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      $__export("uninitialized", $__m.uninitialized);
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      IterableChangesFactory = $__m.IterableChangesFactory;
    }, function($__m) {
      KeyValueChangesFactory = $__m.KeyValueChangesFactory;
    }, function($__m) {
      NullPipeFactory = $__m.NullPipeFactory;
    }],
    execute: function() {
      defaultPipes = $__export("defaultPipes", {
        "iterableDiff": [new IterableChangesFactory(), new NullPipeFactory()],
        "keyValDiff": [new KeyValueChangesFactory(), new NullPipeFactory()]
      });
      DynamicChangeDetection = $__export("DynamicChangeDetection", (function($__super) {
        var DynamicChangeDetection = function DynamicChangeDetection(registry) {
          $traceurRuntime.superConstructor(DynamicChangeDetection).call(this);
          this.registry = registry;
        };
        return ($traceurRuntime.createClass)(DynamicChangeDetection, {createProtoChangeDetector: function(name) {
            var changeControlStrategy = arguments[1] !== (void 0) ? arguments[1] : DEFAULT;
            return new DynamicProtoChangeDetector(this.registry, changeControlStrategy);
          }}, {}, $__super);
      }(ChangeDetection)));
      Object.defineProperty(DynamicChangeDetection, "parameters", {get: function() {
          return [[PipeRegistry]];
        }});
      Object.defineProperty(DynamicChangeDetection.prototype.createProtoChangeDetector, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      JitChangeDetection = $__export("JitChangeDetection", (function($__super) {
        var JitChangeDetection = function JitChangeDetection(registry) {
          $traceurRuntime.superConstructor(JitChangeDetection).call(this);
          this.registry = registry;
        };
        return ($traceurRuntime.createClass)(JitChangeDetection, {createProtoChangeDetector: function(name) {
            var changeControlStrategy = arguments[1] !== (void 0) ? arguments[1] : DEFAULT;
            return new JitProtoChangeDetector(this.registry, changeControlStrategy);
          }}, {}, $__super);
      }(ChangeDetection)));
      Object.defineProperty(JitChangeDetection, "parameters", {get: function() {
          return [[PipeRegistry]];
        }});
      Object.defineProperty(JitChangeDetection.prototype.createProtoChangeDetector, "parameters", {get: function() {
          return [[assert.type.string], [assert.type.string]];
        }});
      _registry = new PipeRegistry(defaultPipes);
      dynamicChangeDetection = $__export("dynamicChangeDetection", new DynamicChangeDetection(_registry));
      jitChangeDetection = $__export("jitChangeDetection", new JitChangeDetection(_registry));
    }
  };
});

System.register("angular2/src/core/compiler/compiler", ["angular2/di", "angular2/src/facade/lang", "angular2/src/facade/async", "angular2/src/facade/collection", "angular2/change_detection", "angular2/src/core/compiler/directive_metadata_reader", "angular2/src/core/compiler/view", "angular2/src/core/compiler/pipeline/compile_pipeline", "angular2/src/core/compiler/pipeline/compile_element", "angular2/src/core/compiler/pipeline/default_steps", "angular2/src/core/compiler/template_loader", "angular2/src/core/compiler/template_resolver", "angular2/src/core/annotations/template", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/core/compiler/pipeline/compile_step", "angular2/src/core/compiler/component_url_mapper", "angular2/src/services/url_resolver", "angular2/src/core/compiler/css_processor"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/compiler/compiler";
  var Injectable,
      Type,
      isBlank,
      isPresent,
      BaseException,
      normalizeBlank,
      stringify,
      Promise,
      PromiseWrapper,
      List,
      ListWrapper,
      Map,
      MapWrapper,
      ChangeDetection,
      Parser,
      DirectiveMetadataReader,
      ProtoView,
      CompilePipeline,
      CompileElement,
      createDefaultSteps,
      TemplateLoader,
      TemplateResolver,
      Template,
      ShadowDomStrategy,
      CompileStep,
      ComponentUrlMapper,
      UrlResolver,
      CssProcessor,
      CompilerCache,
      Compiler;
  return {
    setters: [function($__m) {
      Injectable = $__m.Injectable;
    }, function($__m) {
      Type = $__m.Type;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      normalizeBlank = $__m.normalizeBlank;
      stringify = $__m.stringify;
    }, function($__m) {
      Promise = $__m.Promise;
      PromiseWrapper = $__m.PromiseWrapper;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
      Map = $__m.Map;
      MapWrapper = $__m.MapWrapper;
    }, function($__m) {
      ChangeDetection = $__m.ChangeDetection;
      Parser = $__m.Parser;
    }, function($__m) {
      DirectiveMetadataReader = $__m.DirectiveMetadataReader;
    }, function($__m) {
      ProtoView = $__m.ProtoView;
    }, function($__m) {
      CompilePipeline = $__m.CompilePipeline;
    }, function($__m) {
      CompileElement = $__m.CompileElement;
    }, function($__m) {
      createDefaultSteps = $__m.createDefaultSteps;
    }, function($__m) {
      TemplateLoader = $__m.TemplateLoader;
    }, function($__m) {
      TemplateResolver = $__m.TemplateResolver;
    }, function($__m) {
      Template = $__m.Template;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
    }, function($__m) {
      CompileStep = $__m.CompileStep;
    }, function($__m) {
      ComponentUrlMapper = $__m.ComponentUrlMapper;
    }, function($__m) {
      UrlResolver = $__m.UrlResolver;
    }, function($__m) {
      CssProcessor = $__m.CssProcessor;
    }],
    execute: function() {
      CompilerCache = $__export("CompilerCache", (function() {
        var CompilerCache = function CompilerCache() {
          this._cache = MapWrapper.create();
        };
        return ($traceurRuntime.createClass)(CompilerCache, {
          set: function(component, protoView) {
            MapWrapper.set(this._cache, component, protoView);
          },
          get: function(component) {
            var result = MapWrapper.get(this._cache, component);
            return normalizeBlank(result);
          },
          clear: function() {
            MapWrapper.clear(this._cache);
          }
        }, {});
      }()));
      Object.defineProperty(CompilerCache, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(CompilerCache.prototype.set, "parameters", {get: function() {
          return [[Type], [ProtoView]];
        }});
      Object.defineProperty(CompilerCache.prototype.get, "parameters", {get: function() {
          return [[Type]];
        }});
      Compiler = $__export("Compiler", (function() {
        var Compiler = function Compiler(changeDetection, templateLoader, reader, parser, cache, shadowDomStrategy, templateResolver, componentUrlMapper, urlResolver, cssProcessor) {
          this._changeDetection = changeDetection;
          this._reader = reader;
          this._parser = parser;
          this._compilerCache = cache;
          this._templateLoader = templateLoader;
          this._compiling = MapWrapper.create();
          this._shadowDomStrategy = shadowDomStrategy;
          this._templateResolver = templateResolver;
          this._componentUrlMapper = componentUrlMapper;
          this._urlResolver = urlResolver;
          this._appUrl = urlResolver.resolve(null, './');
          this._cssProcessor = cssProcessor;
        };
        return ($traceurRuntime.createClass)(Compiler, {
          createSteps: function(component, template) {
            var $__0 = this;
            var dirMetadata = ListWrapper.map(this._flattenDirectives(template), (function(d) {
              return $__0._reader.read(d);
            }));
            var cmpMetadata = this._reader.read(component);
            var templateUrl = this._templateLoader.getTemplateUrl(template);
            return createDefaultSteps(this._changeDetection, this._parser, cmpMetadata, dirMetadata, this._shadowDomStrategy, templateUrl, this._cssProcessor);
          },
          compile: function(component) {
            var protoView = this._compile(component);
            return PromiseWrapper.isPromise(protoView) ? protoView : PromiseWrapper.resolve(protoView);
          },
          _compile: function(component) {
            var $__0 = this;
            var protoView = this._compilerCache.get(component);
            if (isPresent(protoView)) {
              return protoView;
            }
            var pvPromise = MapWrapper.get(this._compiling, component);
            if (isPresent(pvPromise)) {
              return pvPromise;
            }
            var template = this._templateResolver.resolve(component);
            var componentUrl = this._componentUrlMapper.getUrl(component);
            var baseUrl = this._urlResolver.resolve(this._appUrl, componentUrl);
            this._templateLoader.setBaseUrl(template, baseUrl);
            var tplElement = this._templateLoader.load(template);
            if (PromiseWrapper.isPromise(tplElement)) {
              pvPromise = PromiseWrapper.then(tplElement, (function(el) {
                return $__0._compileTemplate(template, el, component);
              }), (function(_) {
                throw new BaseException(("Failed to load the template for " + stringify(component)));
              }));
              MapWrapper.set(this._compiling, component, pvPromise);
              return pvPromise;
            }
            return this._compileTemplate(template, tplElement, component);
          },
          _compileTemplate: function(template, tplElement, component) {
            var pipeline = new CompilePipeline(this.createSteps(component, template));
            var compileElements;
            try {
              compileElements = pipeline.process(tplElement, stringify(component));
            } catch (ex) {
              return PromiseWrapper.reject(ex);
            }
            var protoView = compileElements[0].inheritedProtoView;
            this._compilerCache.set(component, protoView);
            MapWrapper.delete(this._compiling, component);
            var nestedPVPromises = [];
            for (var i = 0; i < compileElements.length; i++) {
              var ce = compileElements[i];
              if (ce.hasNestedView) {
                this._compileNestedProtoView(ce, nestedPVPromises);
              }
            }
            if (protoView.stylePromises.length > 0) {
              var syncProtoView = protoView;
              protoView = PromiseWrapper.all(syncProtoView.stylePromises).then((function(_) {
                return syncProtoView;
              }));
            }
            if (nestedPVPromises.length > 0) {
              return PromiseWrapper.then(PromiseWrapper.all(nestedPVPromises), (function(_) {
                return protoView;
              }), (function(e) {
                throw new BaseException((e.message + " -> Failed to compile " + stringify(component)));
              }));
            }
            return protoView;
          },
          _compileNestedProtoView: function(ce, promises) {
            var protoView = this._compile(ce.componentDirective.type);
            if (PromiseWrapper.isPromise(protoView)) {
              ListWrapper.push(promises, protoView.then(function(pv) {
                ce.inheritedElementBinder.nestedProtoView = pv;
              }));
            } else {
              ce.inheritedElementBinder.nestedProtoView = protoView;
            }
          },
          _flattenDirectives: function(template) {
            if (isBlank(template.directives))
              return [];
            var directives = [];
            this._flattenList(template.directives, directives);
            return directives;
          },
          _flattenList: function(tree, out) {
            for (var i = 0; i < tree.length; i++) {
              var item = tree[i];
              if (ListWrapper.isList(item)) {
                this._flattenList(item, out);
              } else {
                ListWrapper.push(out, item);
              }
            }
          }
        }, {});
      }()));
      Object.defineProperty(Compiler, "annotations", {get: function() {
          return [new Injectable()];
        }});
      Object.defineProperty(Compiler, "parameters", {get: function() {
          return [[ChangeDetection], [TemplateLoader], [DirectiveMetadataReader], [Parser], [CompilerCache], [ShadowDomStrategy], [TemplateResolver], [ComponentUrlMapper], [UrlResolver], [CssProcessor]];
        }});
      Object.defineProperty(Compiler.prototype.createSteps, "parameters", {get: function() {
          return [[Type], [Template]];
        }});
      Object.defineProperty(Compiler.prototype.compile, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(Compiler.prototype._compile, "parameters", {get: function() {
          return [[Type]];
        }});
      Object.defineProperty(Compiler.prototype._compileTemplate, "parameters", {get: function() {
          return [[Template], [], [Type]];
        }});
      Object.defineProperty(Compiler.prototype._compileNestedProtoView, "parameters", {get: function() {
          return [[CompileElement], [assert.genericType(List, Promise)]];
        }});
      Object.defineProperty(Compiler.prototype._flattenDirectives, "parameters", {get: function() {
          return [[Template]];
        }});
      Object.defineProperty(Compiler.prototype._flattenList, "parameters", {get: function() {
          return [[assert.genericType(List, assert.type.any)], [assert.genericType(List, Type)]];
        }});
    }
  };
});

System.register("angular2/src/core/application", ["angular2/di", "angular2/src/facade/lang", "angular2/src/dom/browser_adapter", "angular2/src/dom/dom_adapter", "angular2/src/core/compiler/compiler", "angular2/src/core/compiler/view", "angular2/src/reflection/reflection", "angular2/change_detection", "angular2/src/core/exception_handler", "angular2/src/core/compiler/template_loader", "angular2/src/core/compiler/template_resolver", "angular2/src/core/compiler/directive_metadata_reader", "angular2/src/facade/collection", "angular2/src/facade/async", "angular2/src/core/zone/vm_turn_zone", "angular2/src/core/life_cycle/life_cycle", "angular2/src/core/compiler/shadow_dom_strategy", "angular2/src/services/xhr", "angular2/src/services/xhr_impl", "angular2/src/render/dom/events/event_manager", "angular2/src/render/dom/events/hammer_gestures", "angular2/src/di/binding", "angular2/src/core/compiler/component_url_mapper", "angular2/src/services/url_resolver", "angular2/src/render/dom/shadow_dom/style_url_resolver", "angular2/src/render/dom/shadow_dom/style_inliner", "angular2/src/core/compiler/css_processor", "angular2/src/core/annotations/annotations", "angular2/src/core/compiler/private_component_loader", "angular2/src/core/testability/testability"], function($__export) {
  "";
  var __moduleName = "angular2/src/core/application";
  var Injector,
      bind,
      OpaqueToken,
      Type,
      isBlank,
      isPresent,
      BaseException,
      assertionsEnabled,
      print,
      stringify,
      BrowserDomAdapter,
      DOM,
      Compiler,
      CompilerCache,
      ProtoView,
      Reflector,
      reflector,
      Parser,
      Lexer,
      ChangeDetection,
      dynamicChangeDetection,
      jitChangeDetection,
      ExceptionHandler,
      TemplateLoader,
      TemplateResolver,
      DirectiveMetadataReader,
      List,
      ListWrapper,
      Promise,
      PromiseWrapper,
      VmTurnZone,
      LifeCycle,
      ShadowDomStrategy,
      NativeShadowDomStrategy,
      EmulatedUnscopedShadowDomStrategy,
      XHR,
      XHRImpl,
      EventManager,
      DomEventsPlugin,
      HammerGesturesPlugin,
      Binding,
      ComponentUrlMapper,
      UrlResolver,
      StyleUrlResolver,
      StyleInliner,
      CssProcessor,
      Component,
      PrivateComponentLoader,
      TestabilityRegistry,
      Testability,
      _rootInjector,
      _rootBindings,
      appViewToken,
      appChangeDetectorToken,
      appElementToken,
      appComponentAnnotatedTypeToken,
      appDocumentToken;
  function _injectorBindings(appComponentType) {
    return [bind(appDocumentToken).toValue(DOM.defaultDoc()), bind(appComponentAnnotatedTypeToken).toFactory((function(reader) {
      return reader.read(appComponentType);
    }), [DirectiveMetadataReader]), bind(appElementToken).toFactory((function(appComponentAnnotatedType, appDocument) {
      var selector = appComponentAnnotatedType.annotation.selector;
      var element = DOM.querySelector(appDocument, selector);
      if (isBlank(element)) {
        throw new BaseException(("The app selector \"" + selector + "\" did not match any elements"));
      }
      return element;
    }), [appComponentAnnotatedTypeToken, appDocumentToken]), bind(appViewToken).toAsyncFactory((function(changeDetection, compiler, injector, appElement, appComponentAnnotatedType, strategy, eventManager, testability, registry) {
      registry.registerApplication(appElement, testability);
      var annotation = appComponentAnnotatedType.annotation;
      if (!isBlank(annotation) && !(annotation instanceof Component)) {
        var type = appComponentAnnotatedType.type;
        throw new BaseException("Only Components can be bootstrapped; " + ("Directive of " + stringify(type) + " is not a Component"));
      }
      return compiler.compile(appComponentAnnotatedType.type).then((function(protoView) {
        var appProtoView = ProtoView.createRootProtoView(protoView, appElement, appComponentAnnotatedType, changeDetection.createProtoChangeDetector('root'), strategy);
        var view = appProtoView.instantiate(null, eventManager);
        view.hydrate(injector, null, null, new Object(), null);
        return view;
      }));
    }), [ChangeDetection, Compiler, Injector, appElementToken, appComponentAnnotatedTypeToken, ShadowDomStrategy, EventManager, Testability, TestabilityRegistry]), bind(appChangeDetectorToken).toFactory((function(rootView) {
      return rootView.changeDetector;
    }), [appViewToken]), bind(appComponentType).toFactory((function(rootView) {
      return rootView.elementInjectors[0].getComponent();
    }), [appViewToken]), bind(LifeCycle).toFactory((function(exceptionHandler) {
      return new LifeCycle(exceptionHandler, null, assertionsEnabled());
    }), [ExceptionHandler]), bind(EventManager).toFactory((function(zone) {
      var plugins = [new HammerGesturesPlugin(), new DomEventsPlugin()];
      return new EventManager(plugins, zone);
    }), [VmTurnZone]), bind(ShadowDomStrategy).toFactory((function(styleUrlResolver, doc) {
      return new EmulatedUnscopedShadowDomStrategy(styleUrlResolver, doc.head);
    }), [StyleUrlResolver, appDocumentToken]), Compiler, CompilerCache, TemplateResolver, bind(ChangeDetection).toValue(dynamicChangeDetection), TemplateLoader, DirectiveMetadataReader, Parser, Lexer, ExceptionHandler, bind(XHR).toValue(new XHRImpl()), ComponentUrlMapper, UrlResolver, StyleUrlResolver, StyleInliner, bind(CssProcessor).toFactory((function() {
      return new CssProcessor(null);
    }), []), PrivateComponentLoader, Testability];
  }
  function _createVmZone(givenReporter) {
    var defaultErrorReporter = (function(exception, stackTrace) {
      var longStackTrace = ListWrapper.join(stackTrace, "\n\n-----async gap-----\n");
      print((exception + "\n\n" + longStackTrace));
      throw exception;
    });
    var reporter = isPresent(givenReporter) ? givenReporter : defaultErrorReporter;
    var zone = new VmTurnZone({enableLongStackTrace: assertionsEnabled()});
    zone.initCallbacks({onErrorHandler: reporter});
    return zone;
  }
  function bootstrap(appComponentType) {
    var componentServiceBindings = arguments[1] !== (void 0) ? arguments[1] : null;
    var errorReporter = arguments[2] !== (void 0) ? arguments[2] : null;
    BrowserDomAdapter.makeCurrent();
    var bootstrapProcess = PromiseWrapper.completer();
    var zone = _createVmZone(errorReporter);
    zone.run((function() {
      var appInjector = _createAppInjector(appComponentType, componentServiceBindings, zone);
      PromiseWrapper.then(appInjector.asyncGet(appViewToken), (function(rootView) {
        var lc = appInjector.get(LifeCycle);
        lc.registerWith(zone, rootView.changeDetector);
        lc.tick();
        bootstrapProcess.resolve(appInjector);
      }), (function(err) {
        bootstrapProcess.reject(err);
      }));
    }));
    return bootstrapProcess.promise;
  }
  function _createAppInjector(appComponentType, bindings, zone) {
    if (isBlank(_rootInjector))
      _rootInjector = new Injector(_rootBindings);
    var mergedBindings = isPresent(bindings) ? ListWrapper.concat(_injectorBindings(appComponentType), bindings) : _injectorBindings(appComponentType);
    ListWrapper.push(mergedBindings, bind(VmTurnZone).toValue(zone));
    return _rootInjector.createChild(mergedBindings);
  }
  $__export("bootstrap", bootstrap);
  return {
    setters: [function($__m) {
      Injector = $__m.Injector;
      bind = $__m.bind;
      OpaqueToken = $__m.OpaqueToken;
    }, function($__m) {
      Type = $__m.Type;
      isBlank = $__m.isBlank;
      isPresent = $__m.isPresent;
      BaseException = $__m.BaseException;
      assertionsEnabled = $__m.assertionsEnabled;
      print = $__m.print;
      stringify = $__m.stringify;
    }, function($__m) {
      BrowserDomAdapter = $__m.BrowserDomAdapter;
    }, function($__m) {
      DOM = $__m.DOM;
    }, function($__m) {
      Compiler = $__m.Compiler;
      CompilerCache = $__m.CompilerCache;
    }, function($__m) {
      ProtoView = $__m.ProtoView;
    }, function($__m) {
      Reflector = $__m.Reflector;
      reflector = $__m.reflector;
    }, function($__m) {
      Parser = $__m.Parser;
      Lexer = $__m.Lexer;
      ChangeDetection = $__m.ChangeDetection;
      dynamicChangeDetection = $__m.dynamicChangeDetection;
      jitChangeDetection = $__m.jitChangeDetection;
    }, function($__m) {
      ExceptionHandler = $__m.ExceptionHandler;
    }, function($__m) {
      TemplateLoader = $__m.TemplateLoader;
    }, function($__m) {
      TemplateResolver = $__m.TemplateResolver;
    }, function($__m) {
      DirectiveMetadataReader = $__m.DirectiveMetadataReader;
    }, function($__m) {
      List = $__m.List;
      ListWrapper = $__m.ListWrapper;
    }, function($__m) {
      Promise = $__m.Promise;
      PromiseWrapper = $__m.PromiseWrapper;
    }, function($__m) {
      VmTurnZone = $__m.VmTurnZone;
    }, function($__m) {
      LifeCycle = $__m.LifeCycle;
    }, function($__m) {
      ShadowDomStrategy = $__m.ShadowDomStrategy;
      NativeShadowDomStrategy = $__m.NativeShadowDomStrategy;
      EmulatedUnscopedShadowDomStrategy = $__m.EmulatedUnscopedShadowDomStrategy;
    }, function($__m) {
      XHR = $__m.XHR;
    }, function($__m) {
      XHRImpl = $__m.XHRImpl;
    }, function($__m) {
      EventManager = $__m.EventManager;
      DomEventsPlugin = $__m.DomEventsPlugin;
    }, function($__m) {
      HammerGesturesPlugin = $__m.HammerGesturesPlugin;
    }, function($__m) {
      Binding = $__m.Binding;
    }, function($__m) {
      ComponentUrlMapper = $__m.ComponentUrlMapper;
    }, function($__m) {
      UrlResolver = $__m.UrlResolver;
    }, function($__m) {
      StyleUrlResolver = $__m.StyleUrlResolver;
    }, function($__m) {
      StyleInliner = $__m.StyleInliner;
    }, function($__m) {
      CssProcessor = $__m.CssProcessor;
    }, function($__m) {
      Component = $__m.Component;
    }, function($__m) {
      PrivateComponentLoader = $__m.PrivateComponentLoader;
    }, function($__m) {
      TestabilityRegistry = $__m.TestabilityRegistry;
      Testability = $__m.Testability;
    }],
    execute: function() {
      _rootBindings = [bind(Reflector).toValue(reflector), TestabilityRegistry];
      appViewToken = $__export("appViewToken", new OpaqueToken('AppView'));
      appChangeDetectorToken = $__export("appChangeDetectorToken", new OpaqueToken('AppChangeDetector'));
      appElementToken = $__export("appElementToken", new OpaqueToken('AppElement'));
      appComponentAnnotatedTypeToken = $__export("appComponentAnnotatedTypeToken", new OpaqueToken('AppComponentAnnotatedType'));
      appDocumentToken = $__export("appDocumentToken", new OpaqueToken('AppDocument'));
      Object.defineProperty(_createVmZone, "parameters", {get: function() {
          return [[Function]];
        }});
      Object.defineProperty(bootstrap, "parameters", {get: function() {
          return [[Type], [assert.genericType(List, Binding)], [Function]];
        }});
      Object.defineProperty(_createAppInjector, "parameters", {get: function() {
          return [[Type], [assert.genericType(List, Binding)], [VmTurnZone]];
        }});
    }
  };
});

System.register("angular2/core", ["angular2/src/core/annotations/visibility", "angular2/src/core/compiler/interfaces", "angular2/src/core/annotations/template", "angular2/src/core/application", "angular2/src/core/annotations/di", "angular2/src/core/compiler/compiler", "angular2/src/core/compiler/template_loader", "angular2/src/core/compiler/view", "angular2/src/core/compiler/view_container", "angular2/src/core/dom/element"], function($__export) {
  "";
  var __moduleName = "angular2/core";
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  return {
    setters: [function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }],
    execute: function() {}
  };
});

System.register("angular2/angular2", ["angular2/change_detection", "angular2/core", "angular2/annotations", "angular2/directives", "angular2/forms"], function($__export) {
  "";
  var __moduleName = "angular2/angular2";
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  var $__exportNames = {};
  return {
    setters: [function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }, function($__m) {
      Object.keys($__m).forEach(function(p) {
        if (!$__exportNames[p])
          $__export(p, $__m[p]);
      });
    }],
    execute: function() {}
  };
});

//# sourceMappingURLDisabled=angular2.js.map