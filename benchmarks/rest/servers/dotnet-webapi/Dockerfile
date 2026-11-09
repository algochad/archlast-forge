FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY servers/dotnet-webapi/Bench.csproj servers/dotnet-webapi/Program.cs ./
RUN dotnet publish -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out .
ENV DOTNET_TieredPGO=1 DOTNET_gcServer=0
CMD ["dotnet", "Bench.dll"]
