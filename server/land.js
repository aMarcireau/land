const websocket = require('websocket');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// settings
const width = 30; // px
const height = 30; // px
const frameDuration = 200; // ms
const newPlayerPlacementTrials = 10;

/// Player represents a player.
/// id is an integer in the range [0, 127]
/// direction: 0 is right, 1 is up, 2 is left and 3 is down
function Player(id, name, x, y) {
    this.id = id;
    this.name = name;
    this.x = x;
    this.y = y;
    this.direction = 0;
    this.conquering = false;
    this.score = 9;
};

/// Tasks stores the tasks to be resolved at the next frame.
/// type: 0 is new player, 1 is update direction, 2 is an error and 3 is a grid request
function Task(connection, type, parameters = null) {
    this.connection = connection;
    this.type = type;
    this.parameters = parameters;
};

/// kills stores the kills by player (including suicides).
const kills = new Map();
if (fs.existsSync(path.join(__dirname, 'kills.csv'))) {
    fs.readFileSync(path.join(__dirname, 'kills.csv')).toString().split('\n').filter(line => line != '').map(line => {
        const data = line.split(/(?:,\t|,)/);
        return {
            killer: data[0],
            victim: data[1],
        };
    }).forEach(kill => {
        if (!kills.has(kill.killer)) {
            kills.set(kill.killer, new Map());
        }
        if (!kills.get(kill.killer).has(kill.victim)) {
            kills.get(kill.killer).set(kill.victim, 1);
        } else {
            kills.get(kill.killer).set(kill.victim, kills.get(kill.killer).get(kill.victim) + 1);
        }
    });
} else {
    fs.closeSync(fs.openSync(path.join(__dirname, 'kills.csv'), 'w'));
}

/// floodFill fills the target connected area in the image.
function floodFill(image, width, height, x, y, targetId, replacementId) {
    const index = x + y * width;
    if (image[index] != targetId) {
        return;
    }
    const indicesToHandle = [index];
    const handledIndices = new Set();
    while (indicesToHandle.length > 0) {
        const indexToHandle = indicesToHandle.pop();
        if (handledIndices.has(indexToHandle)) {
            continue;
        }
        handledIndices.add(indexToHandle);
        const sourceX = indexToHandle % width;
        const sourceY = Math.floor(indexToHandle / width);
        for (let leftSourceX = sourceX; ; --leftSourceX) {
            const leftIndex = leftSourceX + sourceY * width;
            if (leftSourceX < 0 || image[leftIndex] != targetId) {
                break;
            }
            image[leftIndex] = replacementId;
            if (sourceY > 0) {
                const downIndex = leftSourceX + (sourceY - 1) * width;
                if (image[downIndex] == targetId && !handledIndices.has(downIndex)) {
                    indicesToHandle.push(downIndex);
                }
            }
            if (sourceY < height - 1) {
                const upIndex = leftSourceX + (sourceY + 1) * width;
                if (image[upIndex] == targetId && !handledIndices.has(upIndex)) {
                    indicesToHandle.push(upIndex);
                }
            }
        }
        for (let rightSourceX = sourceX + 1; ; ++rightSourceX) {
            const rightIndex = rightSourceX + sourceY * width;
            if (rightSourceX >= width || image[rightIndex] != targetId) {
                break;
            }
            image[rightIndex] = replacementId;
            if (sourceY > 0) {
                const downIndex = rightSourceX + (sourceY - 1) * width;
                if (image[downIndex] == targetId && !handledIndices.has(downIndex)) {
                    indicesToHandle.push(downIndex);
                }
            }
            if (sourceY < height - 1) {
                const upIndex = rightSourceX + (sourceY + 1) * width;
                if (image[upIndex] == targetId && !handledIndices.has(upIndex)) {
                    indicesToHandle.push(upIndex);
                }
            }
        }
    }
}

// state
// the image's (0, 0) pixel is at the bottom-left corner
const image = Buffer.alloc(width * height * 2);
const playerByKey = new Map();
const tasks = [];
const connections = new Set();

const server = http.createServer((request, response) => {
    if (request.url == '/kills') {
        response.writeHead(200, {'Content-Type': 'application/json'});
        const killsObject = {};
        for (let [killer, victims] of kills) {
            killsObject[killer] = {};
            for (let [victim, count] of victims) {
                killsObject[killer][victim] = count;
            }
        }
        response.end(JSON.stringify(killsObject));
    } else if (request.url == '/') {
        response.writeHead(200, {'Content-Type': 'text/html'});
        fs.createReadStream(path.join(__dirname, 'viewer.html')).pipe(response);
    } else {
        response.writeHead(404);
        response.end();
    }
});

server.listen(3030, () => {
    const websocketServer = new websocket.server({
        httpServer: server,
        autoAcceptConnections: false,
    });

    websocketServer.on('request', request => {
        const connection = request.accept(null, request.origin);
        connections.add(connection);
        connection.on('message', message => {
            if (message.type != 'utf8') {
                tasks.push(new Task(2, {
                    connection: connection,
                    error: 'the message must be utf-8 encoded',
                }));
                return;
            }
            const parameters = message.utf8Data.split(',');
            if (parameters.length != 2) {
                tasks.push(new Task(connection, 2, 'your message must have either the format \'0,player-name\', \'1,-\', or \'key,direction\''));
                return;
            }
            if (parameters[0] === '0') {
                if (parameters[1].length > 21) {
                    tasks.push(new Task(connection, 2, 'player-name cannot have more than 21 characters'));
                    return;
                }
                tasks.push(new Task(connection, 0, parameters[1].replace(/[\|,:]/g, '')));
            } else if (parameters[0] === '1') {
                tasks.push(new Task(connection, 3));
            } else {
                if (!playerByKey.has(parameters[0])) {
                    tasks.push(new Task(connection, 2, 'unknown key'));
                    return;
                }
                const direction = parseInt(parameters[1]);
                if (direction < 0 || direction > 3) {
                    tasks.push(new Task(connection, 2, 'direction must be one of {0, 1, 2, 3}'));
                    return;
                }
                tasks.push(new Task(connection, 1, {key: parameters[0], direction: direction}));
            }
        });
        connection.on('close', (reasonCode, description) => {
            connections.delete(connection);
        });
    });

    const computeFrame = () => {

        // merge tasks with a common connection and sort the tasks by type
        const taskByConnection = new Map();
        for (let task of tasks) {
            taskByConnection.set(task.connection, task);
        }
        const newPlayerByConnection = new Map();
        const errorByConnection = new Map();
        const gridRequestConnections = new Set();
        for (let task of taskByConnection.values()) {
            if (task.connection.connected) {
                switch (task.type) {
                    case 0:
                        newPlayerByConnection.set(task.connection, task.parameters);
                        break;
                    case 1:
                        playerByKey.get(task.parameters.key).direction = task.parameters.direction;
                        break;
                    case 2:
                        errorByConnection.set(task.connection, task.parameters);
                        break;
                    case 3:
                        gridRequestConnections.add(task.connection);
                        break;
                    default:
                        throw new Error('unexpected task type');
                        break;
                }
            }
        }
        while (tasks.length > 0) {
            tasks.pop();
        }

        const territoryUpdateByIndex = new Map();
        const trailUpdateByIndex = new Map();
        const playerPositionById = new Map();
        const newKills = [];

        // first step: move players, kill suicidees
        const deadIds = new Set();
        for (let player of playerByKey.values()) {
            let dead = false;
            switch (player.direction) {
                case 0:
                    ++player.x;
                    dead = (player.x >= width);
                    break;
                case 1:
                    ++player.y;
                    dead = (player.y >= height);
                    break;
                case 2:
                    --player.x;
                    dead = (player.x < 0);
                    break;
                case 3:
                    --player.y;
                    dead = (player.y < 0);
                    break;
                default:
                    throw new Error('unexpected player direction');
                    break;
            }
            if (dead || image[(player.x + player.y * width) * 2 + 1] == player.id) {
                deadIds.add(player.id);
                newKills.push({
                    killer: player.name,
                    victim: player.name,
                });
            }
        }

        // second step: update territories, kill trapped players
        for (let player of playerByKey.values()) {
            if (!deadIds.has(player.id) && player.conquering) {
                const index = player.x + player.y * width;
                if (image[index * 2] == player.id) {
                    player.conquering = false;
                    let minimumX = width;
                    let minimumY = height;
                    let maximumX = -1;
                    let maximumY = -1;
                    for (let x = 0; x < width; ++x) {
                        for (let y = 0; y < height; ++y) {
                            const index = x + y * width;
                            if (image[index * 2 + 1] == player.id) {
                                image[index * 2 + 1] = 0;
                                trailUpdateByIndex.set(index, 0);
                                image[index * 2] = player.id;
                                territoryUpdateByIndex.set(index, player.id);
                            }
                            if (image[index * 2] == player.id) {
                                if (x < minimumX) {
                                    minimumX = x;
                                }
                                if (y < minimumY) {
                                    minimumY = y;
                                }
                                if (x >= maximumX) {
                                    maximumX = x + 1;
                                }
                                if (y >= maximumY) {
                                    maximumY = y + 1;
                                }
                            }
                        }
                    }
                    const temporaryWidth = maximumX - minimumX + 2;
                    const temporaryHeight = maximumY - minimumY + 2;
                    let temporaryImage = Buffer.alloc(temporaryWidth * temporaryHeight);
                    for (let x = minimumX - 1; x < maximumX + 1; ++x) {
                        for (let y = minimumY - 1; y < maximumY + 1; ++y) {
                            const index = x + y * width;
                            if (index >= 0 && index < width * height && image[index * 2] == player.id) {
                                temporaryImage[x - minimumX + 1 + (y - minimumY + 1) * temporaryWidth] = 1;
                            }
                        }
                    }
                    floodFill(temporaryImage, temporaryWidth, temporaryHeight, 0, 0, 0, 2);
                    for (let x = minimumX; x < maximumX; ++x) {
                        for (let y = minimumY; y < maximumY; ++y) {
                            if (temporaryImage[x - minimumX + 1 + (y - minimumY + 1) * temporaryWidth] == 0) {
                                const index = x + y * width;
                                image[index * 2] = player.id;
                                territoryUpdateByIndex.set(index, player.id);
                                for (let otherPlayer of playerByKey.values()) {
                                    if (otherPlayer.id != player.id && otherPlayer.x == x && otherPlayer.y == y) {
                                        deadIds.add(otherPlayer.id);
                                        newKills.push({
                                            killer: player.name,
                                            victim: otherPlayer.name,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // third step: update alive players' status, kill eaten players
        for (let player of playerByKey.values()) {
            if (!deadIds.has(player.id)) {
                const index = player.x + player.y * width;
                if (image[index * 2] != player.id) {
                    player.conquering = true;
                    if (image[index * 2 + 1] != 0) {
                        deadIds.add(image[index * 2 + 1]);
                        let victim = null;
                        for (player of playerByKey.values()) {
                            if (player.id == image[index * 2 + 1]) {
                                victim = player.name;
                                break;
                            }
                        }
                        if (victim != null) {
                            newKills.push({
                                killer: player.name,
                                victim: victim,
                            });
                        }
                    }
                    image[index * 2 + 1] = player.id;
                    trailUpdateByIndex.set(index, player.id);
                }
            }
        }

        // fourth step: reset dead players tiles and update scores
        for (let player of playerByKey.values()) {
            player.score = 0;
        }
        for (let index = 0; index < width * height; ++index) {
            if (deadIds.has(image[index * 2])) {
                image[index * 2] = 0;
                territoryUpdateByIndex.set(index, 0);
            } else {
                for (let player of playerByKey.values()) {
                    if (player.id == image[index * 2]) {
                        ++player.score;
                        break;
                    }
                }
            }
            if (deadIds.has(image[index * 2 + 1])) {
                image[index * 2 + 1] = 0;
                trailUpdateByIndex.set(index, 0);
            }
        }
        for (let [key, player] of playerByKey) {
            if (deadIds.has(player.id)) {
                playerByKey.delete(key);
            } else {
                playerPositionById.set(player.id, player.x + player.y * width);
            }
        }

        // fifth step: insert new players
        const createdPlayerByConnection = new Map();
        if (newPlayerByConnection.size > 0) {
            let availableIds = new Set();
            for (let index = 1; index < 256; ++index) {
                availableIds.add(index);
            }
            for (let player of playerByKey.values()) {
                availableIds.delete(player.id);
            }
            availableIds = Array.from(availableIds).sort((firstId, secondId) => secondId - firstId);
            for (let [connection, name] of newPlayerByConnection) {
                let foundPlacement = false;
                let placementX;
                let placementY;
                for (let trial = 0; trial < newPlayerPlacementTrials; ++trial) {
                    const index = Math.floor(Math.random() * width * height);
                    const x = index % width;
                    const y = Math.floor(index / width);
                    if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) {
                        continue;
                    }
                    let positionIsValid = true;
                    for (let checkX = x - 3; checkX <= x + 3; ++checkX) {
                        let lineIsValid = true;
                        for (let checkY = y - 3; checkY <= y + 3; ++checkY) {
                            const checkIndex = checkX + checkY * width;
                            if (image[checkIndex * 2] > 0 || image[checkIndex * 2 + 1] > 0) {
                                lineIsValid = false;
                                break;
                            }
                        }
                        if (!lineIsValid) {
                            positionIsValid = false;
                            break;
                        }
                    }
                    if (positionIsValid) {
                        foundPlacement = true;
                        placementX = x;
                        placementY = y;
                        break;
                    }
                }
                if (foundPlacement) {
                    const key = crypto.randomBytes(64).toString('base64');
                    const id = availableIds.pop();
                    playerByKey.set(key, new Player(id, name, placementX, placementY));
                    for (let x = placementX - 2; x <= placementX + 2; ++x) {
                        for (let y = placementY - 2; y <= placementY + 2; ++y) {
                            const index = x + y * width;
                            image[index * 2] = id;
                            territoryUpdateByIndex.set(index, id);
                        }
                    }
                    createdPlayerByConnection.set(connection, {key: key, id: id});
                    playerPositionById.set(id, placementX + placementY * width);
                } else {
                    errorByConnection.set(connection, 'there is no place left for you');
                }
            }
        }

        // update the kills database
        for (kill of newKills) {
            if (!kills.has(kill.killer)) {
                kills.set(kill.killer, new Map());
            }
            if (!kills.get(kill.killer).has(kill.victim)) {
                kills.get(kill.killer).set(kill.victim, 1);
            } else {
                kills.get(kill.killer).set(kill.victim, kills.get(kill.killer).get(kill.victim) + 1);
            }
            fs.appendFileSync(path.join(__dirname, 'kills.csv'), `${kill.killer},\t${kill.victim}\n`);
        }

        // send the new image to each connection
        let territoriesUpdates = '';
        if (territoryUpdateByIndex.size > 0) {
            for (let [index, id] of territoryUpdateByIndex) {
                territoriesUpdates += `${index}:${id},`;
            }
            territoriesUpdates = territoriesUpdates.slice(0, -1);
        } else {
            territoriesUpdates = '-';
        }
        let trailsUpdates = '';
        if (trailUpdateByIndex.size > 0) {
            for (let [index, id] of trailUpdateByIndex) {
                trailsUpdates += `${index}:${id},`;
            }
            trailsUpdates = trailsUpdates.slice(0, -1);
        } else {
            trailsUpdates = '-';
        }
        let playersUpdates = '';
        if (playerByKey.size > 0) {
            for (let player of playerByKey.values()) {
                playersUpdates += `${player.id}:${player.name}:${player.x + player.y * width}:${player.score},`;
            }
            playersUpdates = playersUpdates.slice(0, -1);
        } else {
            playersUpdates = '-';
        }
        let territories = '';
        let trails = '';
        if (gridRequestConnections.size > 0) {
            for (let index = 0; index < width * height * 2; index += 2) {
                territories += `${image[index]},`;
                trails += `${image[index + 1]},`;
            }
            territories = territories.slice(0, -1);
            trails = trails.slice(0, -1);
        }

        // fields content:
        //     0: message type
        //     1: new player id or grid width or error message
        //     2: new player key or height
        //     3: territories updates or territories
        //     4: trails updates or trails
        //     5: players updates
        for (let connection of connections) {
            if (createdPlayerByConnection.has(connection)) {
                connection.sendUTF(`0|${createdPlayerByConnection.get(connection).id}|${createdPlayerByConnection.get(connection).key}|${territoriesUpdates}|${trailsUpdates}|${playersUpdates}`);
            } else if (errorByConnection.has(connection)) {
                connection.sendUTF(`2|${errorByConnection.get(connection)}|-|${territoriesUpdates}|${trailsUpdates}|${playersUpdates}`);
            } else if (gridRequestConnections.has(connection)) {
                connection.sendUTF(`3|${width}|${height}|${territories}|${trails}|${playersUpdates}`);
            } else {
                connection.sendUTF(`1|-|-|${territoriesUpdates}|${trailsUpdates}|${playersUpdates}`);
            }
        }

        setTimeout(computeFrame, frameDuration);
    };

    console.log('listening on port 3030');
    computeFrame();
});
