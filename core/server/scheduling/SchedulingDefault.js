var util = require('util'),
    moment = require('moment'),
    request = require('superagent'),
    SchedulingBase = require(__dirname + '/SchedulingBase'),
    errors = require(__dirname + '/../errors');

/**
 * allJobs is a sorted list by time attribute
 */
function SchedulingDefault(options) {
    SchedulingBase.call(this, options);

    this.runTimeoutInMs = 1000 * 60 * 5;
    this.offsetInMinutes = 10;
    this.beforePingInMs = -50;
    this.retryTimeoutInMs = 1000 * 5;

    this.allJobs = {};
    this.deletedJobs = {};
}

util.inherits(SchedulingDefault, SchedulingBase);

/**
 * add to list
 */
SchedulingDefault.prototype.schedule = function (object) {
    this._addJob(object);
};

/**
 * remove from list
 * add to list
 */
SchedulingDefault.prototype.reschedule = function (object) {
    this._deleteJob({time: object.extra.oldTime, url: object.url});
    this._addJob(object);
};

/**
 * remove from list
 * deletion happens right before execution
 */
SchedulingDefault.prototype.unschedule = function (object) {
    this._deleteJob(object);
};

/**
 * check if there are new jobs which needs to be published in the next x minutes
 * because allJobs is a sorted list, we don't have to iterate over all jobs, just until the offset is too big
 */
SchedulingDefault.prototype.run = function () {
    var self = this,
        timeout = null;

    timeout = setTimeout(function () {
        var times = Object.keys(self.allJobs),
            nextJobs = {};

        times.every(function (time) {
            if (moment(Number(time)).diff(moment(), 'minutes') <= self.offsetInMinutes) {
                nextJobs[time] = self.allJobs[time];
                delete self.allJobs[time];
                return true;
            }

            // break!
            return false;
        });

        clearTimeout(timeout);
        self._execute(nextJobs);

        // recursive!
        self.run();
    }, self.runTimeoutInMs);
};

/**
 * each timestamp key entry can have multiple jobs
 */
SchedulingDefault.prototype._addJob = function (object) {
    var timestamp = moment(object.time).valueOf(),
        keys = [],
        sortedJobs = {},
        instantJob = {},
        i = 0;

    // CASE: should have been already pinged or should be pinged soon
    if (moment(timestamp).diff(moment(), 'minutes') < this.offsetInMinutes) {
        instantJob[timestamp] = [object];
        this._execute(instantJob);
        return;
    }

    // CASE: are there jobs already scheduled for the same time?
    if (!this.allJobs[timestamp]) {
        this.allJobs[timestamp] = [];
    }

    this.allJobs[timestamp].push(object);

    keys = Object.keys(this.allJobs);
    keys.sort();

    for (i = 0; i < keys.length; i = i + 1) {
        sortedJobs[keys[i]] = this.allJobs[keys[i]];
    }

    this.allJobs = sortedJobs;
};

SchedulingDefault.prototype._deleteJob = function (object) {
    this.deletedJobs[object.url + '_' + moment(object.time).valueOf()] = true;
};

/**
 * ping jobs
 * setTimeout is not accurate, but we can live with that fact and use setImmediate feature to qualify
 * we don't want to use process.nextTick, this would block any I/O operation
 */
SchedulingDefault.prototype._execute = function (jobs) {
    var keys = Object.keys(jobs),
        self = this;

    keys.forEach(function (timestamp) {
        var timeout = null,
            diff = moment(Number(timestamp)).diff(moment());

        // awake a little before
        timeout = setTimeout(function () {
            clearTimeout(timeout);

            (function retry() {
                var immediate = setImmediate(function () {
                    clearImmediate(immediate);

                    if (moment().diff(moment(Number(timestamp))) <= self.beforePingInMs) {
                        return retry();
                    }

                    var toExecute = jobs[timestamp];
                    delete jobs[timestamp];

                    toExecute.forEach(function (job) {
                        var deleteKey = job.url + '_' + moment(job.time).valueOf();

                        if (self.deletedJobs[deleteKey]) {
                            delete self.deletedJobs[deleteKey];
                            return;
                        }

                        self._pingUrl(job);
                    });
                });
            })();
        }, diff - 200);
    });
};

/**
 * - if we detect to publish a post in the past (case blog is down), we add a force flag
 */
SchedulingDefault.prototype._pingUrl = function (object) {
    var url = object.url,
        time = object.time,
        httpMethod = object.extra.httpMethod,
        tries = object.tries || 0,
        maxTries = 30,
        req = request[httpMethod.toLowerCase()](url),
        self = this, timeout;

    if (moment(time).isBefore(moment())) {
        if (httpMethod === 'GET') {
            req.query('force=true');
        } else {
            req.send({
                force: true
            });
        }
    }

    req.end(function (err, response) {
        if (err) {
            // CASE: post/page was deleted already
            if (response && response.status === 404) {
                return;
            }

            // CASE: blog is in maintenance mode, retry
            if (response && response.status === 503 && tries < maxTries) {
                timeout = setTimeout(function pingAgain() {
                    clearTimeout(timeout);

                    object.tries = tries + 1;
                    self._pingUrl(object);
                }, self.retryTimeoutInMs);
            }

            errors.logError(err);
        }
    });
};

module.exports = SchedulingDefault;
