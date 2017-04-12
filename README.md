Land is a bot-friendly implementation of [Splix](http://splix.io). This repository contains both the game server and an example bot.

# Instructions

## Bot

Run `pip install websocket-client`. The package 'websocket-client' conflicts with the package 'websocket'. The latter  must be uninstalled (if present) before installing 'websocket-client'.
Run `python bot.py` to run the bot.

## Server

Install [nodejs](https://nodejs.org) and run `npm install`.
Run `node land.js` to start the server. The following routes are available:
- *http://localhost:3030/* is an HTML game viewer
- *http://localhost:3030/kills* lists kills in JSON format
