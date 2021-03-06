module.exports = {
    metadata: {
        family: "dataLogger",
        plugin: "dataLogger",
        label: "halytech Data Logger",
        manufacturer: "halytech",
        tangible: true,
        discoverable: false,
        state: [{
            id: "externalPowerVoltage",
            label: "External Power Voltage",
            type: {id: "decimal"}
        }, {
            id: "batteryOneVoltage",
            label: "Battery 1 Voltage",
            type: {id: "decimal"}
        }, {
            id: "batteryOneLevel",
            label: "Battery 1 Level",
            type: {id: "integer"}
        }, {
            id: "batteryTwoVoltage",
            label: "Battery 2 Voltage",
            type: {id: "decimal"}
        }, {
            id: "batteryTwoLevel",
            label: "Battery 2 Level",
            type: {id: "integer"}
        }, {
            id: "temperature",
            label: "Temperature",
            type: {id: "decimal"}
        }, {
            id: "timestamp",
            label: "Timestamp",
            type: {id: "decimal"}
        }],
        configuration: [{
            id: "name",
            label: "Name",
            type: {id: "string"}
        }, {
            id: "type",
            label: "Type",
            type: {id: "string"}
        }, {
            id: "server",
            label: "Server",
            type: {id: "string"}
        }, {
            id: "username",
            label: "User Name",
            type: {id: "string"}
        }, {
            id: "password",
            label: "Password",
            type: {id: "string"}
        }, {
            id: "subject",
            label: "Subject",
            type: {id: "string"}
        }, {
            id: "locationID",
            label: "Location ID",
            type: {id: "string"}
        }, {
            id: "timeZone",
            label: "Time Zone",
            type: {id: "string"}
        }, {
            id: "maxBatteryVoltage",
            label: "Maximum Battery Voltage",
            type: {
                id: "integer"
            },
            defaultValue: 12
        }, {
            id: "interval",
            label: "Interval",
            type: {id: "integer"}
        }],
        actorTypes: [],
        sensorTypes: [],
        services: []
    },
    create: function () {
        return new DataLogger();
    },
    discovery: function (options) {
        var discovery = new DataLoggerDiscovery();

        discovery.options = options;

        return discovery;
    }
};

var q = require('q');
var MailParser;
var csv;
var moment;

function DataLoggerDiscovery() {

    DataLoggerDiscovery.prototype.start = function () {
    };

    DataLoggerDiscovery.prototype.stop = function () {
    };
}
/**
 *
 */
function DataLogger() {
    /**
     *
     */
    DataLogger.prototype.start = function () {

        this.operationalState = {
            status: 'PENDING',
            message: 'Waiting for initialization...'
        };
        this.publishOperationalStateChange();

        this.logDebug("Starting halytech data logger.");

        if ((this.configuration.interval > 0) && (this.configuration.interval < 360)) {
            this.logDebug("Applying interval of " + this.configuration.interval + " minutes as configured.");
        } else {
            this.logDebug("Configured interval of " + this.configuration.interval + " minutes is out of range; changing " +
                "to 15 minutes.");
            this.configuration.interval = 15;
        }

        if ((this.configuration.maxBatteryVoltage > 0) && (this.configuration.maxBatteryVoltage < 36)) {
            this.logDebug("Applying max battery level of " + this.configuration.maxBatteryVoltage + " volt as configured.");
        } else {
            this.logDebug("Max configured battery voltage of " + this.configuration.maxBatteryVoltage
                + " is out of range; changing to 12 volt.");
            this.configuration.maxBatteryVoltage = 12;
        }

        this.intervals = [];
        this.simulationIntervals = [];
        this.state = {};
        this.stateChanges = [];
        this.lastPublished = new Date(1);

        if (this.isSimulated()) {
            this.simulationIntervals.push(setInterval(function () {
                var simulatedState = {
                    timestamp: new Date(),
                    state: {
                        externalPowerVoltage: 0,
                        batteryOneVoltage: Number((Math.random() * 10).toFixed(3)),
                        batteryTwoVoltage: Number((Math.random() * 10).toFixed(3)),
                        temperature: Number((Math.random() * (20 - 30) + 30).toFixed(1))
                    }
                };

                simulatedState.state.batteryOneLevel = this.calculateBatteryLevel(simulatedState.state.batteryOneVoltage);
                simulatedState.state.batteryTwoLevel = this.calculateBatteryLevel(simulatedState.state.batteryTwoVoltage);

                this.stateChanges.push(simulatedState);
                this.logDebug('Simulated device status change ('
                    + simulatedState.state.externalPowerVoltage + ','
                    + simulatedState.state.batteryOneVoltage + ','
                    + simulatedState.state.batteryOneLevel + ','
                    + simulatedState.state.batteryTwoVoltage + ','
                    + simulatedState.state.batteryTwoLevel + ','
                    + simulatedState.state.temperature + ').');
            }.bind(this), 10000));

            this.simulationIntervals.push(setInterval(function () {
                this.publishHistoricData();
            }.bind(this), 24000));

            this.operationalState = {
                status: 'OK',
                message: 'Halytech Data Logger successfully initialized'
            }
            this.publishOperationalStateChange();
        } else {
            this.pollData();
            this.intervals.push(setInterval(function () {
                this.pollData();
            }.bind(this), this.configuration.interval * 60000))

            this.operationalState = {
                status: 'OK',
                message: 'Halytech Data Logger successfully initialized'
            }
            this.publishOperationalStateChange();
        }

        return q();
    };

    DataLogger.prototype.calculateBatteryLevel = function (voltage) {
        var batteryLevel = 0;

        try {
            batteryLevel = Math.round((voltage / this.configuration.maxBatteryVoltage * 100));
        } catch (e) {
            this.logDebug(e);
        }

        return batteryLevel;
    }

    DataLogger.prototype.pollData = function () {
        try {
            var promise = this.pollEmail(this.configuration.name)
                .then(function (csvData) {
                    return this.readCSVData(csvData);
                }.bind(this))
                .then(function (data) {
                    var actors = {};
                    var line;
                    var lastOwnStateChange = null;
                    var currentTimestamp;
                    var currentReading;
                    var dateFromFile;
                    var dateString;
                    var anotherDate;

                    if (!moment) {
                        moment = require('moment-timezone');
                    }

                    for (var n in this.actors) {
                        actors[this.actors[n].configuration.channel] = this.actors[n];
                    }

                    for (var n in data) {
                        line = data[n];

                        dateFromFile = new Date(line[1] + 'Z'); // read with local time zone using Date parsing
                        dateString = dateFromFile.toISOString();
                        dateString = dateString.substr(0, dateString.length - 1); // strip time zone info
                        anotherDate = moment.tz(dateString, this.configuration.timeZone); // add configured timeZone
                        currentTimestamp = new Date(anotherDate.format()); // convert back to date

                        currentReading = parseFloat(line[2]);

                        try {
                            //TODO create one generic method that updates lastOwnStateChange instead of the spaghetti below
                            switch (line[0]) {
                                case "External Power Vol_reading":
                                    if (!lastOwnStateChange) {
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    } else if (currentTimestamp.getTime() != lastOwnStateChange.timestamp.getTime()) {
                                        this.stateChanges.push(lastOwnStateChange);
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    }

                                    lastOwnStateChange.state.externalPowerVoltage = currentReading;
                                    break;

                                case "Battery 1 Voltage_reading":
                                    if (!lastOwnStateChange) {
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    } else if (currentTimestamp.getTime() != lastOwnStateChange.timestamp.getTime()) {
                                        this.stateChanges.push(lastOwnStateChange);
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    }

                                    lastOwnStateChange.state.batteryOneVoltage = currentReading;
                                    lastOwnStateChange.state.batteryOneLevel = this.calculateBatteryLevel(currentReading);
                                    break;

                                case "Battery 2 Voltage_reading":
                                    if (!lastOwnStateChange) {
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    } else if (currentTimestamp.getTime() != lastOwnStateChange.timestamp.getTime()) {
                                        this.stateChanges.push(lastOwnStateChange);
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    }

                                    lastOwnStateChange.state.batteryTwoVoltage = currentReading;
                                    lastOwnStateChange.state.batteryTwoLevel = this.calculateBatteryLevel(currentReading);
                                    break;

                                case "System Temp_reading":
                                    if (!lastOwnStateChange) {
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    } else if (currentTimestamp.getTime() != lastOwnStateChange.timestamp.getTime()) {
                                        this.stateChanges.push(lastOwnStateChange);
                                        lastOwnStateChange = this.initHistoricState(currentTimestamp);
                                    }

                                    lastOwnStateChange.temperature = currentReading;
                                    break;

                                default:
                                    var readingPos = line[0].indexOf("_reading");
                                    var cumulatedReading = (readingPos > -1);

                                    if (cumulatedReading) {
                                        channelId = line[0].substr(0, readingPos);
                                    } else {
                                        channelId = line[0];
                                    }

                                    var actor = actors[channelId];

                                    if (actor) {
                                        if (cumulatedReading) {
                                            actor.addCumulatedReading({
                                                id: channelId,
                                                timestamp: currentTimestamp,
                                                cumulatedReading: currentReading
                                            });
                                        } else {
                                            actor.addReading({
                                                id: channelId,
                                                timestamp: currentTimestamp,
                                                reading: currentReading
                                            });
                                        }
                                    } else {
                                        this.logDebug("Channel " + channelId + " not configured, ignoring data.");
                                    }

                                    break;
                            }
                        } catch (e) {
                            this.logError("Error reading csv data.", e);
                        }
                    }

                    for (var n in this.actors) {
                        this.actors[n].publishHistoricData();
                    }


                    if (lastOwnStateChange) {
                        this.stateChanges.push(lastOwnStateChange);
                        this.publishHistoricData();
                    } else {
                        this.logDebug('No state changes on device.');
                    }

                    return q();
                }.bind(this))
                .catch(function (err) {
                    this.logDebug(err);
                }.bind(this));
        } catch (e) {
            this.logDebug(e);
            promise = q();
        }

        return promise;
    };

    /**
     *
     */
    DataLogger.prototype.publishHistoricData = function () {
        var currentStateChange;
        var comparisonTime = this.lastPublished;

        this.logInfo("Publishing " + this.stateChanges.length + " device state changes.");
        this.publishStateChangeHistory(this.stateChanges);

        for (var n in this.stateChanges) {
            currentStateChange = this.stateChanges[n];

            if (currentStateChange.timestamp > comparisonTime) {
                this.state = {
                    externalPowerVoltage: currentStateChange.state.externalPowerVoltage,
                    batteryOneVoltage: currentStateChange.state.batteryOneVoltage,
                    batteryOneLevel: currentStateChange.state.batteryOneLevel,
                    batteryTwoVoltage: currentStateChange.state.batteryTwoVoltage,
                    batteryTwoLevel: currentStateChange.state.batteryTwoLevel,
                    temperature: currentStateChange.state.temperature
                };

                this.lastPublished = currentStateChange.timestamp;
            }

        }

        this.publishStateChange();
        this.stateChanges = [];
        this.logDebug('Finished publishing historic device state changes.');
        return q();
    };

    DataLogger.prototype.initHistoricState = function (timestamp) {
        return {
            timestamp: timestamp,
            state: {
                externalPowerVoltage: 0,
                batteryOneVoltage: 0,
                batteryOneLevel: 0,
                batteryTwoVoltage: 0,
                batteryTwoLevel: 0,
                temperature: 0
            }
        };
    };

    /**
     *
     */
    DataLogger.prototype.stop = function () {
        for (var interval in this.intervals) {
            clearInterval(interval);
        }

        for (var interval in this.simulationIntervals) {
            clearInterval(interval);
        }
    };

    DataLogger.prototype.readCSVData = function (csvData) {
        var deferred = q.defer();

        if (csvData) {
            if (!csv) {
                csv = require('csv');
            }

            csv.parse(csvData, function (err, data) {
                if (err) {
                    deferred.reject(err);
                } else {
                    deferred.resolve(data);
                }
            }.bind(this));
        } else {
            deferred.reject("No data received.");
        }

        return deferred.promise;
    };


    /**
     *
     */
    DataLogger.prototype.setState = function (state) {
        this.state = state;
    };

    /**
     *
     */
    DataLogger.prototype.getState = function () {
        return this.state;
    };

    DataLogger.prototype.pollEmail = function (name) {
        var deferred = q.defer();

        var Imap = require('imap'),
            inspect = require('util').inspect;

        var imap = new Imap({
            user: this.configuration.username,
            password: this.configuration.password,
            host: this.configuration.server,
            port: 993,
            tls: true,
        });

        imap.once('ready', function () {
            imap.openBox('INBOX', false, function (err, box) {

                if (err) deferred.reject(e);

                imap.search(['UNSEEN', ['HEADER', 'SUBJECT', this.configuration.subject]], function (err, results) {

                    if ((results) && (results.length) && (results.length > 0)) {
                        this.logInfo('Found ' + results.length + ' new email matching subject "' + this.configuration.subject
                            + '" found for user "' + this.configuration.username + '" on server "'
                            + this.configuration.server + '".');


                        var f = imap.fetch(results, {
                            bodies: '',
                            struct: true,
                            markRead: true,
                            markSeen: true
                        });

                        f.on('message', function (msg, seqno) {
                            if (!MailParser) {
                                MailParser = require("mailparser").MailParser;
                            }

                            var mailparser = new MailParser();

                            mailparser.on("headers", function (headers) {
//                                console.log(headers.received);
                            }.bind(this));

                            mailparser.on("end", function (mail) {
                                if (mail.attachments) {
                                    this.logInfo('Analyzing message with subject "' + mail.subject
                                        + '" and ' + mail.attachments.length + ' attachments.');
                                    var attachment;

                                    for (var n in mail.attachments) {
                                        attachment = mail.attachments[n];

                                        if (attachment.generatedFileName.indexOf(this.configuration.locationID) > -1) {
                                            this.logDebug('Found matching attachment ' + attachment.generatedFileName);
                                            var dataLoggerInfo = attachment.content.toString('UTF8').trim().replace(/\r\n/g, "\n");

                                            deferred.resolve(dataLoggerInfo);
                                            break;
                                        } else {
                                            this.logDebug('Ignored attachment ' + attachment.generatedFileName);
                                        }
                                    }

                                } else {
                                    this.logInfo('Parsed and ignored message with subject "' + mail.subject
                                        + '" and no attachments.');
                                    deferred.resolve();
                                }
                            }.bind(this));

                            msg.on('body', function (stream, info) {
                                stream.pipe(mailparser);
                            }.bind(this));

                            msg.on("end", function () {
                                /*
                                 console.log("End");
                                 mailparser.end();
                                 */
                            }.bind(this));
                        }.bind(this));

                        f.once('error', function (err) {
                            this.logDebug('Fetch error: ' + err);
                            deferred.reject(err);
                        }.bind(this));

                        f.once('end', function () {
                            this.logDebug('Done fetching all messages!');
                            imap.end();
                        }.bind(this));
                    } else {
                        deferred.reject('No new email matching subject "' + this.configuration.subject
                            + '" found for user "' + this.configuration.username + '" on server "'
                            + this.configuration.server + '".');
                    }
                }.bind(this));
            }.bind(this));
        }.bind(this));

        imap.once('error', function (err) {
            deferred.reject(err);
        }.bind(this));

        imap.once('end', function () {
            this.logDebug('Connection ended');
        }.bind(this));

        try {
            imap.connect();
        } catch (e) {
            deferred.reject(e);
        }

        return deferred.promise;
    }

}
