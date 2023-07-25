# Todo [![Deploy to Fastly](https://deploy.edgecompute.app/button)](https://deploy.edgecompute.app/JakeChampion/todo)

This is a todo web application where:
- It's all hosted on Fastly Compute@Edge
- The todo-lists are persistently stored in Fastly KV Store
- Updates to todo-lists are pushed out to all connected clients in real-time

## Features

- [x] Create new lists
- [x] Add
- [x] Remove
- [x] Edit
- [x] Mark Completed
- [x] Filter Completed/Incomplete
- [x] Re-order items in list
- [x] Remove all completed items
- [x] Toggle all items to be completed/incomplete


# Deploying

If deploying to your own Fastly Service, you will need to:
- Update the backend named `self` to have the domain of the Fastly Service
- Turn on Fanout for the Fastly Service
