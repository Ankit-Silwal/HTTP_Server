import net from "node:net";

const MAX_HEADER_SIZE=8192;
const IDLE_TIMEOUT=10_000;

// Example: curl.exe -v http://localhost:3000/hello
//
// What curl sends over TCP (\r\n written out, normally invisible):
//
//   GET /hello HTTP/1.1\r\n          -> bytes  0-20
//   Host: localhost:3000\r\n         -> bytes 21-42
//   User-Agent: curl/8.21.0\r\n      -> bytes 43-67
//   Accept: */*                      -> bytes 68-78
//   \r\n\r\n                         -> bytes 79-82 (end of headers)
//
// Raw bytes (hex) in the Buffer:
//   G  E  T     /  h  e  l  l  o
//   47 45 54 20 2f 68 65 6c 6c 6f ...
//
// With keep-alive, the same connection can carry more requests,
// so the buffer can hold the next one right after byte 82:
//
//   [ request 1: bytes 0-82 ][ request 2: bytes 83-... ]

const server=net.createServer((socket)=>{
  console.log("Client is connected");

  // empty bucket for this connection -> <Buffer >, length 0
  let request=Buffer.alloc(0);
  let requestsServed=0;
  let closing=false;

  // no data for 10s -> close the idle connection
  socket.setTimeout(IDLE_TIMEOUT);
  socket.on("timeout",()=>{
    console.log("Idle connection timeout");
    closing=true;
    socket.end();
  });

  socket.on("data",(chunk:Buffer)=>{
    if(closing) return;

    // TCP can split a request into pieces, so we keep adding them:
    //   data #1 chunk -> "GET /hello HTTP/1.1\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\n"
    //   data #2 chunk -> "Host: localhost:3000\r\n"
    //   request       -> "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\n"
    //   data #3 chunk -> "User-Agent: curl/8.21.0\r\nAccept: */*\r\n\r\n"
    //   request       -> full headers (now contains \r\n\r\n)
    request=Buffer.concat([request,chunk]);

    // one chunk can contain several requests -> handle them one by one
    while(true){
      // where do the headers end?
      //   not arrived yet -> -1
      //   full example    -> 79
      const index=request.indexOf("\r\n\r\n");

      if(index===-1){
        // too big and still no end of headers -> reject
        //this goes to the up things and again buffer.concat occurs!
        if(request.length>MAX_HEADER_SIZE){
          closing=true;
          socket.end(
            "HTTP/1.1 431 Request Header Fields Too Large\r\n"+
            "Content-Length: 0\r\n"+
            "Connection: close\r\n"+
            "\r\n"
          );
        }
        return; // wait for more data
      }

      // headers finished but bigger than the limit -> reject
      if(index+4>MAX_HEADER_SIZE){
        closing=true;
        socket.end(
          "HTTP/1.1 431 Request Header Fields Too Large\r\n"+
          "Content-Length: 0\r\n"+
          "Connection: close\r\n"+
          "\r\n"
        );
        return;
      }

      // subarray(0,79) -> header bytes only (without \r\n\r\n)
      // toString()     -> bytes to text:
      //   "GET /hello HTTP/1.1\r\nHost: localhost:3000\r\nUser-Agent: curl/8.21.0\r\nAccept: */*"
      const text=request.subarray(0,index).toString();

      // cut off this request (79 + 4 = 83) and keep whatever comes after it:
      //   only one request -> request = <Buffer >
      //   two requests     -> request = bytes of request 2
      request=request.subarray(index+4);

      // split("\r\n") ->
      //   firstLine = "GET /hello HTTP/1.1"
      //   headers   = ["Host: localhost:3000","User-Agent: curl/8.21.0","Accept: */*"]
      const [firstLine,...headers]=text.split("\r\n");

      // split(" ") -> ["GET","/hello","HTTP/1.1"]
      const [method,path,version]=firstLine.split(" ");
      console.log("Method:",method);
      console.log("Path:",path);

      // only plain GET with HTTP/1.1 and no body for now
      const unsupported=
        version!=="HTTP/1.1"||
        method!=="GET"||
        headers.some(h=>/^(content-length|transfer-encoding)\s*:/i.test(h));

      if(unsupported){
        closing=true;
        socket.end(
          "HTTP/1.1 400 Bad Request\r\n"+
          "Content-Length: 0\r\n"+
          "Connection: close\r\n"+
          "\r\n"
        );
        return;
      }

      // routing
      let status="200 OK";
      let body="";
      if(path==="/hello"){
        body="Hello from my tcp server";
      }else if(path==="/health"){
        body="Server is healthy";
      }else{
        status="404 Not Found";
        body="Route not found";
      }

      requestsServed++;
      console.log("Requests on connection:",requestsServed);

      // client sent "Connection: close" -> close after this response
      // otherwise HTTP/1.1 keeps the connection open (keep-alive)
      const shouldClose=headers.some(h=>/^connection\s*:\s*close\s*$/i.test(h));

      // response = status line + headers + empty line + body
      const response=
        `HTTP/1.1 ${status}\r\n`+
        "Content-Type: text/plain\r\n"+
        `Content-Length: ${Buffer.byteLength(body)}\r\n`+
        `Connection: ${shouldClose?"close":"keep-alive"}\r\n`+
        "\r\n"+
        body;

      if(shouldClose){
        closing=true;
        socket.end(response); // send and close
        return;
      }

      socket.write(response); // send and keep the connection open
    }
  });

  socket.on("close",()=>{
    console.log("Client disconnected");
  });

  socket.on("error",(err)=>{
    console.log("Socket error:",err.message);
  });
});

// 0.0.0.0 -> listen on every address this PC has (localhost, Wi-Fi IP, ...)
server.listen(3000,"0.0.0.0",()=>{
  console.log("TCP server is running on port 3000");
});
