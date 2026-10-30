from pytm import TM, Actor, Boundary, Dataflow, Datastore, Server, Data, Classification

tm = TM("Notes web app")
tm.description = "Express web app where signed-in users create, list, read, edit and delete their own private text notes."
tm.isOrdered = True

internet = Boundary("Internet")
server_boundary = Boundary("Server")

user = Actor("Signed-in user")
user.inBoundary = internet

visitor = Actor("Anonymous visitor")
visitor.inBoundary = internet

web_app = Server("Web app")
web_app.inBoundary = server_boundary
web_app.protocol = "HTTPS"
web_app.dstPort = 3000
web_app.controls.isHardened = True
web_app.controls.sanitizesInput = True
web_app.controls.authenticatesSource = True
web_app.controls.encodesOutput = True
web_app.controls.validatesInput = True

notes_db = Datastore("Notes DB")
notes_db.inBoundary = server_boundary
notes_db.isSQL = True
notes_db.storesPII = True
notes_db.controls.isEncrypted = False
notes_db.controls.hasAccessControl = True

note_data = Data("Note text", classification=Classification.SENSITIVE)
session_data = Data("User id and session identifier", classification=Classification.RESTRICTED)

user_req = Dataflow(user, web_app, "Notes request")
user_req.protocol = "HTTPS"
user_req.dstPort = 443
user_req.controls.isEncrypted = True
user_req.data = [note_data, session_data]

user_resp = Dataflow(web_app, user, "Notes response")
user_resp.protocol = "HTTPS"
user_resp.controls.isEncrypted = True
user_resp.data = note_data

visitor_req = Dataflow(visitor, web_app, "Anonymous request")
visitor_req.protocol = "HTTPS"
visitor_req.dstPort = 443
visitor_req.controls.isEncrypted = True

visitor_resp = Dataflow(web_app, visitor, "Unauthorized response")
visitor_resp.protocol = "HTTPS"
visitor_resp.controls.isEncrypted = True

db_write = Dataflow(web_app, notes_db, "Store note query")
db_write.protocol = "SQL"
db_write.data = note_data

db_read = Dataflow(notes_db, web_app, "Read note result")
db_read.protocol = "SQL"
db_read.data = note_data

if __name__ == "__main__":
    tm.process()
