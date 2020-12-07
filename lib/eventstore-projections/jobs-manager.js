const _ = require('lodash');
const {
    join
} = require('lodash');
const debug = require('debug')('eventstore:jobs-manager');

/**
 * RedisConfig
 * @typedef {Object} RedisConfig
 * @property {String} host the redis host
 * @property {Number} port the redis port
 * @property {Password} password the redis password
 */

/**
 * Redis
 * @typedef {Object} IORedis
 */

/**
 * JobsManagerOptions
 * @typedef {Object} JobsManagerOptions
 * @property {Object} BullQueue the bull queue
 * @property {IORedis} redis the ioredis library
 * @property {Number} concurrency the number of concurrent jobs in a jog group
 */

/**
 * Job
 * @typedef {Object} Job
 * @property {String} id unique id of the job
 * @property {String} group group of this job
 * @property {Object} payload payload of the job
 */

/**
 * JobsManager
 * @typedef {Object} JobsManager
 * @property {QueueJob} queueJob queue a job
 * @property {ProcessJobGroup} processJobGroup process a job by group
 */


/**
 * JobDoneCallback
 * @callback JobDoneCallback
 * @param {Error} error optional error if an error occurred in processing the job
 * @param {Object} result result to save for this job. can be used when processing the same job with the same id again
 */

/**
 * OnProcessJob
 * @callback OnProcessJob
 * @param {Object} owner the owner of the callbacks
 * @param {Number} jobId the job id
 * @param {Number} jobData the job data
 * @param {Object} lastResult result that was last saved with the same job id
 * @param {JobDoneCallback} done the callback to say that the job is done
 */

/**
 * OnProcessJobCompleted
 * @callback OnProcessJobCompleted
 * @param {Object} owner the owner of the callbacks
 * @param {Number} jobId the job id
 * @param {Number} jobData the job data
 */

/**
 * ProcessJobGroup
 * @callback ProcessJobGroup
 * @param {Object} owner the owner/instance of the callbacks
 * @param {String} jobGroup the job object toe queue
 * @param {OnProcessJob} onProcessJob callback on when a job needs to be processed
 * @param {OnProcessJobCompleted} onProcessJobCompleted callback on when a job is completed
 */

/**
 * JobResult
 * @typedef {Object} JobResult
 * @property {Object} lastResult the lastResult of a process read, contains lastOffset
 */

/**
 * QueueJob
 * @callback QueueJob
 * @param {Job} job the job object toe queue
 * @param {JobOptions} options some configuration/options for this job
 */


/**
 * JobOptions
 * @typedef {Object} JobOptions
 * @property {Number} delay number of milliseconds to sleep before processing this job
 * @property {Number} attempts number of milliseconds to sleep before processing this job
 * @property {Object} backoff number of milliseconds to sleep before processing this job
 */


/**
 * JobsManager constructor
 * @class
 * @param {JobsManagerOptions} options additional options for the jobs manager
 * @constructor
 */
function JobsManager(options) {
    options = options || {};
    var defaults = {
        concurrency: 20
    };

    this.options = _.defaults(options, defaults);

    debug('jobs-manager constructor with options', this.options);
    this._jobGroupsQueue = {};
    this._jobs = {};
}


/**
 * @type {JobsManagerOptions}
 */
JobsManager.prototype.options;

/**
 * @type {Object.<string, Job>}
 */
JobsManager.prototype._jobs;

/**
 * @type {Object}
 */
JobsManager.prototype._jobGroupsQueue;

/**
 * @param {Object} owner the instance/object that will be used as owner of the callback
 * @param {String} jobGroup the job group to process
 * @param {OnProcessJob} onProcessJob callback to be called when a job is to be processed
 * @param {OnProcessJobCompleted} onCompletedJob callback to be called when a job is completed
 * @returns {Promise<void>} - returns a Promise of type void
 */
JobsManager.prototype.processJobGroup = async function(owner, jobGroup, options, onProcessJob, onCompletedJob) {
    try {
        debug('processJobGroup called with params:', jobGroup);

        if (!owner) {
            throw new Error('owner is required');
        }

        if (!jobGroup) {
            throw new Error('jobGroup is required');
        }

        if (!onProcessJob || !_.isFunction(onProcessJob)) {
            throw new Error('onProcessJob is missing or is not a function');
        }

        if (!onCompletedJob || !_.isFunction(onCompletedJob)) {
            throw new Error('onCompletedJob is missing or is not a function');
        }
        const self = this;
        let queue = this._getJobGroupsQueue(jobGroup);


        debug('_jobGroupsQueue', this._jobGroupsQueue);
        debug('got queue', queue);

        if (queue) {
            queue.on('error', function(job, err) {
                // An error occured.
                if (job.failedReason == 'job stalled more than allowable limit') {
                    job.retry();
                }
                console.error('ON error:', err);
            });
            queue.on('waiting', function(jobId) {
                // A Job is waiting to be processed as soon as a worker is idling.
                debug('ON waiting:', jobId);
            });
            queue.on('active', function(job, jobPromise) {
                // A job has started. You can use `jobPromise.cancel()`` to abort it.
                debug('ON active:');
            });
            queue.on('progress', function(job, progress) {
                // A job's progress was updated!
                debug('ON progress:', job.id, (progress * 100));
            });
            queue.on('paused', function() {
                // The queue has been paused.
                debug('ON paused');
            });
            queue.on('resumed', function(job) {
                // The queue has been resumed.
                debug('ON resumed:', job.id);
            });
            queue.on('cleaned', function(jobs, type) {
                // Old jobs have been cleaned from the queue. `jobs` is an array of cleaned
                // jobs, and `type` is the type of jobs cleaned.
                debug('ON cleaned:', type, jobs);
            });
            queue.on('drained', function() {
                // Emitted every time the queue has processed all the waiting jobs (even if there can be some delayed jobs not yet processed)
                debug('ON drained');
            });
            queue.on('removed', function(job) {
                // A job successfully removed.
                debug('ON removed:', job.id);
            });

            queue.on('stalled', function(job) {
                // A job has been marked as stalled. This is useful for debugging job
                // workers that crash or pause the event loop.
                debug('ON stalled:', job.id);
                // TODO: handle STALLED event
                // self._changeStatus(job.data.key, 'STALLED');
            });

            queue.on('failed', function(job, err) {
                // A job failed with reason `err`!
                console.error('job failed:', job.id, err);

                // An error occured.
                if (job.failedReason == 'job stalled more than allowable limit') {
                    job.retry();
                } else {
                    if (job.attemptsMade == job.opts.attempts) {
                        // TODO: we exhausted all retry attempts. need to call for developer
                        console.error('exhausted all retry attemps. send an email for critical error');
                    } else {
                        console.error(`failed but retrying. attempt ${job.attemptsMade} of ${job.opts.attempts}`);
                    }
                }

                console.error('ON error:', err);
                // TODO: handle FAILED event
                // self._changeStatus(job.data.key, 'FAILED', err);
            });

            queue.on('completed', function(job, result) {
                // A job successfully completed with a `result`.
                debug('ON completed:', job, self._jobs, result);
                onCompletedJob.call(owner, job.id, job.data, result);
            });

            const concurrency = options && options.concurrency ? options.concurrency : this.options.concurrency;
            queue.process(concurrency, async function(job) {
                let jobResult = await self._getJobResult(job);
                const lastResult = jobResult ? jobResult.lastResult : null;
                const result = await onProcessJob.call(owner, job.id, job.data, lastResult);

                if (jobResult == null) {
                    jobResult = {};
                }
                jobResult.lastResult = result;
                await self._setJobResult(job, jobResult);
                return result;
            });
        }
    } catch (error) {
        console.error('error in processJobGroup with params and error:', jobGroup, error);
        throw error;
    }
};

/**
 * 
 * @param {Job} job the job to queue
 * @returns {Promise<JobResult>} - returns a Promise of type JobResult
 */
JobsManager.prototype._getJobResult = async function(job) {
    const key = `eventstore-projection-job:${job.id}`;
    let jobResult = null;
    const resultKeys = await this.options.redis.keys(key);
    if (resultKeys && resultKeys.length > 0) {
        jobResult = await this.options.redis.hgetall(resultKeys[0]);
        jobResult.lastResult = jobResult.lastResult ? JSON.parse(jobResult.lastResult) : null;
    }
    return jobResult;
}

/**
 * 
 * @param {Job} job the job to queue
 * @param {JobResult} jobResult the end product of processing job
 * @returns {Promise<Void>} - returns a Promise of type void
 */
JobsManager.prototype._setJobResult = async function(job, jobResult) {
    const key = `eventstore-projection-job:${job.id}`;
    return this.options.redis.hmset(key, this._objectToKeyValueArray(jobResult));
}

/**
 * @param {Job} job the job to queue
 * @param {JobOptions} options the options for the job
 * @returns {Promise<void>} - returns a Promise of type void
 */
JobsManager.prototype.queueJob = async function(job, options) {
    try {
        debug('queueJob called with params:', job, options);

        if (!job) {
            throw new Error('job is required');
        }

        if (!job.id) {
            throw new Error('id is required');
        }

        if (!job.group) {
            throw new Error('group is required');
        }

        if (!job.payload) {
            throw new Error('payload is required');
        }

        let queue = this._getJobGroupsQueue(job.group);

        this._jobs[job.id] = job;

        await queue.add(job.payload, {
            jobId: job.id,
            delay: options ? options.delay : undefined,
            removeOnComplete: true,
            timeout: options ? options.timeout : undefined,
            attempts: options && options.attempts ? options.attempts : 10,
            backoff: options && options.backoff ? options.backoff : {
                type: 'exponential',
                delay: 2000,
            }
        });
    } catch (error) {
        console.error('error in queueJob with params and error:', job, error);
        throw error;
    }
};

/**
 * @param {Number} jobId 
 * @param {String} jobGroup
 * @returns {Void} - returns void value
 */
JobsManager.prototype.promoteJob = async function(jobId, jobGroup) {
    try {
        debug('promoteJob called with params:', jobId);

        if (!jobId) {
            throw new Error('job id is required');
        }

        let queue = this._getJobGroupsQueue(jobGroup);
        const job = await queue.getJob(jobId);
        if (job && job.queue) {
            await job.promote();
        }
    } catch (error) {
        // DO NOTHING
        // NOTE: promote job error can be ignored since it only tells whether the promoted job is already processed/out of queue
        // console.error('error in queueJob with params and error:', error);
    }
};


/**
 * @param {Object} obj object to convert to key value array
 * @returns {Array} - key value array returned from object
 */
JobsManager.prototype._objectToKeyValueArray = function(obj) {
    const pairs = [];
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            pairs.push(key);
            if (this._isObject(obj[key]) || Array.isArray(obj[key])) {
                pairs.push(JSON.stringify(obj[key]));
            } else {
                pairs.push(obj[key]);
            }
        }
    }
    return pairs;
};

/**
 * @param {Any} val object to convert to key value array
 * @returns {Bool} - determines if val is object
 */
JobsManager.prototype._isObject = function(val) {
    if (val === null) {
        return false;
    }
    return (typeof val === 'object');
};

/**
 * @param {String} jobGroup the job group
 * @returns {BullQueue} - returns a bull queue
 */
JobsManager.prototype._getJobGroupsQueue = function(jobGroup) {
    let queue = this._jobGroupsQueue[jobGroup];

    if (!queue) {
        queue = this._jobGroupsQueue[jobGroup] = new this.options.BullQueue(jobGroup, {
            redis: this.options.redis.options
        });
    }

    return queue;
};


module.exports = JobsManager;