import logging
import websocket
import thread
import time
import sys
import random
import pip
logging.basicConfig()

# addres is the game server address
# you may want to change it for local development
address = 'ws://localhost:3030'

# name is your player's name
name = 'Super Tarsier'

# handleChange is called when the game is updated
#     - id is your unique player id
#     - width is the game's grid width in pixels
#     - height is the game's grid height in pixels
#     - territories is a (with * height) long array containing:
#         - 0 if the pixel belongs to no one's territory
#         - i if the pixel belongs to the player with id i's territory
#         The pixel with coordinates (x, y) has the index i = (x + y * width)
#     - trails is a (with * height) long array containing:
#         - 0 if the pixel belongs to no one's trail
#         - i if the pixel belongs to the player with id i's trail
#         The pixel with coordinates (x, y) has the index i = (x + y * width)
#     - players is a dictionary mapping players' ids with their indexed position
#         A players with index i has coordinates (x, y) = (i % width, i / width)
#     - callback is a function to be called with the new direction for your player:
#         - 0 is right
#         - 1 is up
#         - 2 is left
#         - 3 is down
#         If you do not call the callback function within one second after handleChange starts, your player will not change its direction.
def handleChange(id, width, height, territories, trails, players, callback):
    x = players[id] % width
    y = players[id] / width
    availableDirections = []
    if x < width - 1 and trails[x + 1 + y * width] != id:
        availableDirections.append(0)
    if y < height - 1 and trails[x + (y + 1) * height] != id:
        availableDirections.append(1)
    if x > 0 and trails[x - 1 + y * height] != id:
        availableDirections.append(2)
    if y > 0 and trails[x + (y - 1) * height] != id:
        availableDirections.append(3)
    if len(availableDirections) == 0:
        callback(0)
    else:
        callback(random.choice(availableDirections))

# play starts a bot with the given name and change handler
# you should not have to mingle with this function, unless you are willing to rewrite the parser to boost the performance
def play(address, name, handleChange):
    parameters = {'id': None, 'width': None, 'height': None, 'territories': None, 'trails': None, 'players': {}, 'key': None}

    def on_message(ws, message):
        data = message.split('|');

        if data[0] == '3':
            parameters['width'] = int(data[1])
            parameters['height'] = int(data[2])
            parameters['territories'] = data[3].split(',')
            parameters['trails'] = data[4].split(',')
            parameters['players'] = {}
            if data[5] != '-':
                for player in data[5].split(','):
                    playerData = player.split(':')
                    parameters['players'][int(playerData[0])] = int(playerData[2])
            ws.send('0,' + name)
            return

        if parameters['territories'] == None:
            return

        if data[3] != '-':
            for update in data[3].split(','):
                indexAndId = update.split(':')
                parameters['territories'][int(indexAndId[0])] = int(indexAndId[1])

        if data[4] != '-':
            for update in data[4].split(','):
                indexAndId = update.split(':')
                parameters['trails'][int(indexAndId[0])] = int(indexAndId[1])

        parameters['players'] = {}
        if data[5] != '-':
            for player in data[5].split(','):
                playerData = player.split(':')
                parameters['players'][int(playerData[0])] = int(playerData[2])

        if data[0] == '2':
            print data[1]

        if data[0] == '0':
            parameters['id'] = int(data[1])
            parameters['key'] = data[2]

        if parameters['id'] != None:
            if parameters['id'] not in parameters['players']:
                print 'You are dead'
                sys.exit(0)
            def callback(direction):
                parsedDirection = int(direction)
                if parsedDirection < 0 or parsedDirection > 3:
                    print 'direction must be an integer in the range [0, 3]'
                ws.send(parameters['key'] + ',' + str(parsedDirection))
            handleChange(
                id = parameters['id'],
                width = parameters['width'],
                height = parameters['height'],
                territories = parameters['territories'],
                trails = parameters['trails'],
                players = parameters['players'],
                callback = callback
            )

    def on_error(ws, error):
        if error.message != 0:
            print error

    def on_close(ws):
        print 'the connection was closed'

    def on_open(ws):
        ws.send('1,-')

    ws = websocket.WebSocketApp(
        address,
        on_message = on_message,
        on_error = on_error,
        on_close = on_close
    )
    ws.on_open = on_open
    ws.run_forever()

if __name__ == '__main__':
    play(address, name, handleChange)
