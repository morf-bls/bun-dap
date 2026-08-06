const port = Number(process.env.PORT ?? 3999);

Bun.serve({
    port,
    fetch(req) {
        const url = req.url;
        console.log('hit', url);
        return new Response('ok');
    },
});
