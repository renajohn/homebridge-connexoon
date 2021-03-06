const EventType = require('./event-type');

const MAX_EXPONENT = 7;

class EventsController {

    constructor(log, eventFactory, overkiz, activeFrequencyMs = 5 * 1000, refreshFrequencyMs = 10 * 1000, executionGarbageCollectorCMs = 3 * 60 * 1000) {
        this.overkiz = overkiz;
        this.eventFactory = eventFactory;
        this.log = log;
        this.executionGarbageCollectorCMs = executionGarbageCollectorCMs;
        this.activeFrequencyMs = activeFrequencyMs;
        this.refreshFrequencyMs = refreshFrequencyMs;
        this.backoffExponent = 0;
        this.activeCount = 0;
        this.isConnected = false;

        this.listenerId = null;

        this.executionToDeviceUrl = {};
        this.timer = null;
        this.subscribers = {};
    }

    async start() {
        try {
            await this.registerEventController();
            this.startGarbageCollector();
        } catch (e) {
            this.log.error(`Failed to register event listener`);
        }
    }

    async registerEventController() {
        try {
            this.listenerId = await this.overkiz.registerEvents();
            this.setAsConnected();
            this.fetchEventsLoop();
            this.log(`Event listener registered`)
        } catch (e) {
            this.log.error(`Failed to register event listener`);
            this.retryEventsRegistration();
        }
    }

    retryEventsRegistration() {
        this.isConnected = false;

        if (this.backoffTimer) {
            return;
        }
        let timeout = this.exponentialBackoffMs();
        this.log.warn(`Retry registration in ${timeout / 1000}s`);
        this.backoffTimer = setTimeout(this.resetEventControllerRegistration.bind(this), timeout);
    }

    setAsConnected() {
        this.backoffExponent = 0;
        this.isConnected = true;
        this.backoffTimer = null;
    }

    exponentialBackoffMs() {
        this.backoffExponent = Math.min(this.backoffExponent + 1, MAX_EXPONENT);
        return Math.pow(2, this.backoffExponent) * 1000;
    }

    resetEventControllerRegistration() {
        this.log(`Trying to re-register to event listener`);
        this.backoffTimer = null;
        this.registerEventController();
    }

    // As I don't know all execution exit point and I don't trust the system fully, I prefer to have
    // a safety net to remove execution that has been active for too long. I would suggest setting the
    // timeout to 3min
    startGarbageCollector() {
        setInterval(this.garbageCollectExecutions.bind(this), this.executionGarbageCollectorCMs);
    }

    garbageCollectExecutions() {
        let now = Date.now();
        for (const execId in this.executionToDeviceUrl) {
            if (now - this.executionToDeviceUrl[execId].timestamp >= this.executionGarbageCollectorCMs) {
                this.log.warn(`Garbage collected ${execId}.`);
                this.removeExecution(execId);
            }
        }
    }

    removeExecution(execId) {
        delete this.executionToDeviceUrl[execId];
    }

    async fetchEventsLoop() {
        try {
            await this.fetchEvents();
        } catch (e) {
            this.log.warn(`Failed to retrieve latest events, retry events registration.`);
            return this.retryEventsRegistration();
        }

        let timoutMs = this.activeCount ? this.activeFrequencyMs : this.refreshFrequencyMs;
        this.log.debug(`Next fetch in ${timoutMs/1000}s.`);
        this.timer = setTimeout(this.fetchEventsLoop.bind(this), timoutMs);
        this.decreaseActiveCount();
    }

    async fetchEvents() {
        if (!this.isConnected) {
            return;
        }

        let eventsJson = await this.overkiz.fetchEvents(this.listenerId);

        if (Array.isArray(eventsJson) && eventsJson.length > 0) {
            let events = eventsJson
                .map(this.processJsonEvent.bind(this))
                .filter(event => event != null)
                .reduce((prev, curr) => prev.concat(curr));

            events.forEach(this.callSubscriber.bind(this));

            if (events.length > 0) {
                this.resetActiveCount();
            }
        }
    }

    processJsonEvent(jsonEvent) {
        let events = this.eventFactory.createEvents(jsonEvent, this.getDeviceUrlsForExecId(jsonEvent.execId));

        if (events)
            events.forEach(this.updateExecutionLifeCycle.bind(this));

        return events;
    }

    updateExecutionLifeCycle(event) {
        switch(event.type) {
            case EventType.DeviceStateChangedEventType:
                // nothing to do in this case
                break;
            case EventType.ExecutionRegisteredEventType:
                this.assignDeviceUrlToExecId(event.execId, event.id);
                break;
            case EventType.ExecutionStateChangedEventType:
                if (event.hasStopped) {
                    this.removeExecution(event.execId);
                }
                break;
            default:
                this.log.error(`Unknown event type for ${event.name}: ${event.type}`);
        } 
    }

    callSubscriber(event) {
        if (event.id == null) {
            this.log.warn(`Event has no id ${event}`);
            return;
        }

        this.subscribers[event.id] && this.subscribers[event.id](event);
    }

    assignDeviceUrlToExecId(execId, deviceURL) {
        if (!this.executionToDeviceUrl[execId]) {
            this.executionToDeviceUrl[execId] = { timestamp: Date.now(), deviceURLs: new Set() };
        }

        this.executionToDeviceUrl[execId].deviceURLs.add(deviceURL);
    }

    resetActiveCount() {
        this.activeCount = 4;
    }

    decreaseActiveCount() {
        --this.activeCount;
        if (this.activeCount < 0)
            this.activeCount = 0;
    }

    getDeviceUrlsForExecId(execId) {
        if (!this.executionToDeviceUrl[execId]) {
            return [];
        }

        return Array.from(this.executionToDeviceUrl[execId].deviceURLs);
    }

    subscribe(deviceURL, cb) {
        this.subscribers[deviceURL] = cb;
    }

    stopFetch() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = EventsController;