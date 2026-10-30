
#include <cassert>
#include <string>
#include <vector>
#include <algorithm>
#include <cstdint>
#include <map>
#include <cstdio>
#include <cctype>
class String:public std::string {public:using std::string::string;using std::string::operator=;String(const std::string&s):std::string(s){}String substring(size_t p)const{return substr(p);}void toLowerCase(){for(char&c:*this)c=std::tolower(c);}};
constexpr int WL_CONNECTED=3,WIFI_OFF=0,WIFI_STA=1,WIFI_AP=2,WIFI_AP_STA=3,WIFI_SCAN_RUNNING=-1;
constexpr int WIFI_AUTH_OPEN=0,WIFI_AUTH_WPA_PSK=2,WIFI_AUTH_WPA2_PSK=3,WIFI_AUTH_WPA_WPA2_PSK=4,WIFI_AUTH_WPA3_PSK=6,WIFI_AUTH_WPA2_WPA3_PSK=7;
constexpr unsigned kJoinTimeoutMs=20000,kMaxJoinFailures=3,kPortalIdleTimeoutMs=900000,kScanTimeoutMs=15000,kSavedNetworkBackoffMs=30000;
constexpr size_t kMaxSavedWifiNetworks=5;
uint32_t clockNow=100;uint32_t millis(){return clockNow;}
void esp_fill_random(void* buffer,size_t size){static uint32_t seed=1;auto* bytes=static_cast<unsigned char*>(buffer);for(size_t i=0;i<size;++i){seed=seed*1664525+1013904223;bytes[i]=static_cast<unsigned char>(seed>>24);}}
int scanStops=0;int esp_wifi_scan_stop(){++scanStops;return 0;}
struct {uint64_t getEfuseMac(){return 1;}} ESP;
struct Ip {String value;Ip(String v="192.0.2.1"):value(v){}String toString(){return value;}bool operator!=(const Ip&other)const{return value!=other.value;}};
struct ScanRow{String ssid;int rssi,auth;};
struct Radio {
 int connected=0,currentMode=WIFI_STA,scanState=-1,begins=0,scanCalls=0;
 bool deferDisconnect=false,persistentSetting=true,autoReconnect=true;
 void persistent(bool value){persistentSetting=value;}void setAutoReconnect(bool value){autoReconnect=value;}
 String associated,requested,password;std::vector<ScanRow>rows;
 int status(){return connected;}String SSID(){return associated;}
 String SSID(int i){return rows[i].ssid;}int RSSI(int i){return rows[i].rssi;}int encryptionType(int i){return rows[i].auth;}
 int getMode(){return currentMode;}void mode(int value){currentMode=value;}
 void disconnect(bool,bool=false,unsigned=0){if(!deferDisconnect){connected=0;associated="";}}
 void begin(const char*s,const char*p){assert(connected!=WL_CONNECTED);requested=s;password=p;++begins;}
 int scanNetworks(bool async,bool hidden){assert(async&&!hidden);++scanCalls;scanState=-1;return -1;}
 int scanComplete(){return scanState;}void scanDelete(){}Ip localIP(){return {};}Ip softAPIP(){return Ip("192.168.4.1");}
 unsigned softAPgetStationNum(){return 0;}
 void join(const String&ssid){associated=ssid;connected=WL_CONNECTED;}
} WiFi;
struct WifiNetworkProfile{String ssid,password;};
struct DeviceStore {
 std::vector<WifiNetworkProfile> profiles{{"primary","password1"},{"backup","password2"}};
 int saves=0,activations=0;bool resetOk=true;bool saveOk=true;String gateway="https://production.example";
 struct Snapshot {String wifiSsid,wifiPassword;};
 Snapshot transportSnapshot(){return profiles.empty()?Snapshot{}:Snapshot{profiles[0].ssid,profiles[0].password};}
 std::vector<WifiNetworkProfile>savedWifiNetworksSnapshot(){return profiles;}
 std::vector<String>savedWifiNamesSnapshot(){std::vector<String>names;for(auto&p:profiles)names.push_back(p.ssid);return names;}
 bool hasWifiCredentials(){return !profiles.empty();}String wifiSsid(){return profiles.empty()?String():profiles[0].ssid;}
 bool saveWifiNetwork(const String&s,const String&p){++saves;if(!saveOk)return false;profiles.erase(std::remove_if(profiles.begin(),profiles.end(),[&](const auto&v){return v.ssid==s;}),profiles.end());profiles.insert(profiles.begin(),{s,p});return true;}
 bool activateSavedWifiNetwork(const String&s){++activations;auto copy=profiles;for(auto&p:copy)if(p.ssid==s){if(!saveOk)return false;profiles.erase(std::remove_if(profiles.begin(),profiles.end(),[&](const auto&v){return v.ssid==s;}),profiles.end());profiles.insert(profiles.begin(),p);return true;}return false;}
 bool resetForProvisioning(){if(!resetOk)return false;profiles.clear();return true;}
 bool setGatewayUrl(const String&s){gateway=s;return true;}
};
struct DNSServer {void processNextRequest(){}};
struct WebServer {
 String host="192.168.4.1";std::map<String,String>headers;int status=0;String body;
 struct Client{Ip ip=Ip("192.168.4.1");Ip localIP(){return ip;}}connection;
 explicit WebServer(int){}void handleClient(){}Client& client(){return connection;}
 String hostHeader(){return host;}String header(const char* name){return headers[name];}
 void sendHeader(const char*,const char*){}void send(int code,const char*,const String& value){status=code;body=value;}
};
struct {template<class...T>void printf(const char*,T...){}void println(const char*){}}Serial;
@@DECLARATION@@
int portals=0;
void Provisioning::startPortal(bool){portalUp_=true;portalLastClientAt_=millis();++portals;}
void Provisioning::stopPortal(){portalUp_=false;}
@@METHODS@@
void attach(Provisioning& p,DeviceStore& store){p.store_=&store;p.status_.state=ProvisioningState::Online;WiFi.join(store.wifiSsid());p.knownGoodNetwork_=true;}
